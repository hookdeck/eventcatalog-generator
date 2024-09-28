import utils from '@eventcatalog/sdk';
import chalk from 'chalk';
import { generateVersion } from './lib';
import { HookdeckClient } from '@hookdeck/sdk';
import { Destination, Source } from '@hookdeck/sdk/api';
import { createSchema } from 'genson-js';
import pino from 'pino';
import pretty from 'pino-pretty';

// The event.catalog.js values for your plugin
export type EventCatalogConfig = any;

// Configuration the users give your catalog
export type GeneratorProps = {
  logLevel?: pino.Level;
  projectDir?: string;
  hookdeckApiKey?: string;
  connectionSourcedMatch?: string;
};

export default async (config: EventCatalogConfig, options: GeneratorProps) => {
  const stream = pretty();
  const logger = pino(
    {
      level: options.logLevel || 'info',
    },
    stream
  );

  const eventCatalogDirectory = options.projectDir || process.env.PROJECT_DIR;
  const hookdeckApiKey = options.hookdeckApiKey || process.env.HOOKDECK_PROJECT_API_KEY;

  if (!eventCatalogDirectory) {
    const msg = 'Please provide catalog url (env variable PROJECT_DIR)';
    logger.error(msg);
    throw new Error(msg);
  }

  if (!hookdeckApiKey) {
    const msg = 'Please provide Hookdeck Project API Key (env variable HOOKDECK_PROJECT_API_KEY)';
    logger.error(msg);
    throw new Error(msg);
  }

  const hookdeckClient = new HookdeckClient({ token: hookdeckApiKey });

  const connectionsResponse = await hookdeckClient.connection.list();
  if (connectionsResponse.models !== undefined && connectionsResponse.models.length === 0) {
    logger.info('No connections found');
    return;
  }

  let connections = connectionsResponse.models!;
  const connectionSourceMatch = options.connectionSourcedMatch ? new RegExp(options.connectionSourcedMatch) : undefined;
  if (connectionSourceMatch) {
    logger.info(`Applying Connection Source Match: "${connectionSourceMatch}"`);
    logger.debug(connectionSourceMatch);

    connections = connections.filter((c) => {
      if (connectionSourceMatch && connectionSourceMatch.test(c.source.name) === false) {
        logger.debug(`Connection "${c.source.name}" does not match "${connectionSourceMatch}"`);
        return false;
      }
      return true;
    });
  }

  logger.info(`Found ${connections.length} connections`);
  logger.debug(
    `Generating Event Catalog for ${connections.length} Connections with Sources: \n${connections
      .map((c) => `- ${c.source.name}`)
      .join('\n')}`
  );

  const sources: { [key: string]: Source } = {};
  const destinations: { [key: string]: Destination } = {};

  for (const connection of connections) {
    sources[connection.source.id] = connection.source;
    destinations[connection.destination.id] = connection.destination;
  }

  // if (options.debug) {
  //   logger.debug('Exiting early due to debug flag');
  //   return;
  // }

  // EventCatalog SDK (https://www.eventcatalog.dev/docs/sdk)
  const { writeService, getService, writeEvent, getEvent, addEventToService } = utils(eventCatalogDirectory);

  // Create a Service for each Source
  for (const source of Object.values(sources)) {
    const serviceVersion = generateVersion(source.updatedAt);
    const existingSourceService = await getService(source.id, serviceVersion);

    if (!existingSourceService) {
      await writeService({
        id: source.id,
        name: source.name,
        version: serviceVersion,
        markdown: source.description || '',
      });
    } else {
      logger.debug(`Service for Source ${source.name} already exists`);
    }

    const requests = await hookdeckClient.request.list({ sourceId: source.id });
    if (requests.models) {
      logger.debug(`Found ${requests.models.length} Requests for Source ${source.id}`);

      for (let i = 0; i < requests.models.length; ++i) {
        const request = requests.models[i];

        const fullRequest = await hookdeckClient.request.retrieve(request.id);
        let eventType = `${source.id}:${i}`;
        let schema = undefined;

        if (fullRequest.data) {
          // Create schema
          logger.trace(`Request ID: ${request.id}`, JSON.stringify(fullRequest.data));
          try {
            schema = createSchema(fullRequest.data.body);
            logger.trace(`Schema for Request ID: ${request.id}`, JSON.stringify(schema));
          } catch (e) {
            logger.error(`Error generating schema for Request ID: ${request.id}`, e);
          }

          // Try to determine an event type
          if (fullRequest.data.body && typeof fullRequest.data.body === 'object') {
            if ('type' in fullRequest.data.body) {
              eventType = fullRequest.data.body.type as string;
            } else if ('eventType' in fullRequest.data.body) {
              eventType = fullRequest.data.body.eventType as string;
            } else {
              logger.warn(`Could not determine event type. No 'type' or 'eventType' field found in Request ID: ${request.id}`);
            }
          }
        } else {
          logger.error(`fullRequest.data is undefined for request ID: ${request.id}`);
        }

        const eventVersion = generateVersion(request.createdAt);
        // TODO: apply areSchemasEqual logic from genson-js
        const existingEvent = await getEvent(eventType, eventVersion);
        if (!existingEvent) {
          // EventCatalog does not support "." in event IDs
          const eventId = eventType.replace('.', ':');
          await writeEvent({
            id: eventId,
            markdown: `
### Schema

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

### Example

#### Body

\`\`\`json
${JSON.stringify(fullRequest.data?.body, null, 2)}
\`\`\`

#### Headers

\`\`\`json
${JSON.stringify(fullRequest.data?.headers, null, 2)}
\`\`\`
`,
            name: eventType,
            version: eventVersion,
          });

          await addEventToService(source.id, 'sends', {
            id: eventId,
            version: eventVersion,
          });

          logger.debug(`Written event for Request: ${JSON.stringify(request)}`);
        } else {
          logger.debug(`Event ${eventType} already exists`);
        }
      }
    }
  }

  logger.info(chalk.green(`Created Services for ${Object.keys(sources).length} Sources`));

  if (options.logLevel === 'trace') {
    logger.debug('Exiting early due to trace flag');
    return;
  }

  // Create a Service for each Destination
  for (const destination of Object.values(destinations)) {
    const destinationVersion = generateVersion(destination.updatedAt);
    const existingSourceService = await getService(destination.id, destinationVersion);

    if (!existingSourceService) {
      await writeService({
        id: destination.id,
        name: destination.name,
        version: generateVersion(destination.updatedAt),
        markdown: destination.description || '',
      });
    } else {
      logger.debug(`Service or Destination ${destination.name} already exists`);
    }

    const events = await hookdeckClient.event.list({ destinationId: destination.id });
    if (events.models) {
      logger.debug(`Found ${events.models.length} Events for Destination ${destination.id}`);

      for (let i = 0; i < events.models.length; ++i) {
        const event = events.models[i];

        // TODO: extract schema from event
        // TODO: determine a way to generate an ID for the event

        const eventId = `${event.id}:${i}`;

        const eventVersion = generateVersion(event.createdAt);
        const existingEvent = await getEvent(eventId, eventVersion);
        if (!existingEvent) {
          await writeEvent({
            id: eventId,
            markdown: `Example:
            ${JSON.stringify(event.data, null, 2)}`,
            name: eventId,
            version: eventVersion,
          });

          await addEventToService(destination.id, 'receives', {
            id: eventId,
            version: eventVersion,
          });

          logger.debug(`Written event for Event: ${JSON.stringify(event)}`);
        } else {
          logger.debug(`Event ${eventId} already exists`);
        }
      }
    }
  }

  logger.info(chalk.green(`Created Services for ${Object.keys(destinations).length} Destinations`));
};
