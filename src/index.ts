import utils from '@eventcatalog/sdk';
import chalk from 'chalk';
import { generateVersion } from './lib';
import { HookdeckClient } from '@hookdeck/sdk';
import { Connection, Destination, Source } from '@hookdeck/sdk/api';

// The event.catalog.js values for your plugin
export type EventCatalogConfig = any;

// Configuration the users give your catalog
export type GeneratorProps = {
  debug?: boolean;
  projectDir?: string;
  hookdeckApiKey?: string;
  connectionSourcedMatch?: string;
};

let _debug = false;

const logInfo = (...args: any[]) => {
  console.info(chalk.blue.apply(chalk, args));
};
const logSuccess = (...args: any[]) => {
  console.log(chalk.green.apply(chalk, args));
};
const logError = (...args: any[]) => {
  console.log(chalk.red.apply(chalk, args));
};
const logDebug = (...args: any[]) => {
  if (_debug) {
    console.debug.apply(console, args);
  }
};

export default async (config: EventCatalogConfig, options: GeneratorProps) => {
  const eventCatalogDirectory = options.projectDir || process.env.PROJECT_DIR;
  const hookdeckApiKey = options.hookdeckApiKey || process.env.HOOKDECK_PROJECT_API_KEY;

  if (!eventCatalogDirectory) {
    const msg = 'Please provide catalog url (env variable PROJECT_DIR)';
    logError(msg);
    throw new Error(msg);
  }

  if (!hookdeckApiKey) {
    const msg = 'Please provide Hookdeck Project API Key (env variable HOOKDECK_PROJECT_API_KEY)';
    logError(msg);
    throw new Error(msg);
  }

  _debug = options.debug || false;

  const hookdeckClient = new HookdeckClient({ token: hookdeckApiKey });

  const connectionsResponse = await hookdeckClient.connection.list();
  if (connectionsResponse.models !== undefined && connectionsResponse.models.length === 0) {
    logInfo('No connections found');
    return;
  }

  let connections = connectionsResponse.models!;
  const connectionSourceMatch = options.connectionSourcedMatch ? new RegExp(options.connectionSourcedMatch) : undefined;
  if (connectionSourceMatch) {
    logInfo(`Applying Connection Source Match: "${connectionSourceMatch}"`);
    logDebug(connectionSourceMatch);

    connections = connections.filter((c) => {
      if (connectionSourceMatch && connectionSourceMatch.test(c.source.name) === false) {
        logDebug(`Connection "${c.source.name}" does not match "${connectionSourceMatch}"`);
        return false;
      }
      return true;
    });
  }

  logInfo(`Found ${connections.length} connections`);
  logDebug(
    `Generating Event Catalog for ${connections.length} Connections with Sources: \n${connections.map((c) => `- ${c.source.name}\n`)}`
  );

  const sources: { [key: string]: Source } = {};
  const destinations: { [key: string]: Destination } = {};

  for (const connection of connections) {
    sources[connection.source.id] = connection.source;
    destinations[connection.destination.id] = connection.destination;
  }

  // if (options.debug) {
  //   logDebug('Exiting early due to debug flag');
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
      logDebug(`Service for Source ${source.name} already exists`);
    }

    const requests = await hookdeckClient.request.list({ sourceId: source.id });
    if (requests.models) {
      logDebug(`Found ${requests.models.length} Requests for Source ${source.id}`);

      for (let i = 0; i < requests.models.length; ++i) {
        const request = requests.models[i];

        // TODO: extract schema from request
        // https://www.npmjs.com/package/genson-js
        // TODO: determine a way to generate an ID for the event

        const eventId = `${source.id}:${i}`;

        const eventVersion = generateVersion(request.createdAt);
        const existingEvent = await getEvent(eventId, eventVersion);
        if (!existingEvent) {
          await writeEvent({
            id: eventId,
            markdown: `Example:
          ${JSON.stringify(request.data, null, 2)}`,
            name: eventId,
            version: eventVersion,
          });

          await addEventToService(source.id, 'receives', {
            id: eventId,
            version: eventVersion,
          });

          logDebug(`Written event for Request: ${JSON.stringify(request)}`);
        } else {
          logDebug(`Event ${eventId} already exists`);
        }
      }
    }
  }

  logSuccess(`Created Services for ${Object.keys(sources).length} Sources`);

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
      logDebug(`Service or Destination ${destination.name} already exists`);
    }

    const events = await hookdeckClient.event.list({ destinationId: destination.id });
    if (events.models) {
      logDebug(`Found ${events.models.length} Events for Destination ${destination.id}`);

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

          logDebug(`Written event for Event: ${JSON.stringify(event)}`);
        } else {
          logDebug(`Event ${eventId} already exists`);
        }
      }
    }
  }

  logSuccess(`Created Services for ${Object.keys(destinations).length} Destinations`);
};
