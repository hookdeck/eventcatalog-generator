import utils from '@eventcatalog/sdk';
import chalk from 'chalk';
import { generateVersion, sleep } from './lib';
import { HookdeckClient } from '@hookdeck/sdk';
import { Destination, Source } from '@hookdeck/sdk/api';
import { createSchema, Schema } from 'genson-js';
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
  domain?: string;
  processMaxEvents?: number;
};

const EVENT_ID_SEPARATOR = '-';
const SLEEP_TIME = 200;

class Generator {
  config: EventCatalogConfig;
  options: GeneratorProps;
  eventCatalogDirectory: string;
  hookdeckApiKey: string;
  generationRunDate: Date;
  processMaxEvents: number;
  logger: any;
  hookdeckClient: HookdeckClient;

  constructor(config: EventCatalogConfig, options: GeneratorProps) {
    this.config = config;
    this.options = options;

    const eventCatalogDirectory = options.projectDir || process.env.PROJECT_DIR;
    const hookdeckApiKey = options.hookdeckApiKey || process.env.HOOKDECK_PROJECT_API_KEY;

    const stream = pretty();
    this.logger = pino(
      {
        level: options.logLevel || 'info',
      },
      stream
    );

    if (!eventCatalogDirectory) {
      const msg = 'Please provide catalog url (env variable PROJECT_DIR)';
      this.logger.error(msg);
      throw new Error(msg);
    }

    if (!hookdeckApiKey) {
      const msg = 'Please provide Hookdeck Project API Key (env variable HOOKDECK_PROJECT_API_KEY)';
      this.logger.error(msg);
      throw new Error(msg);
    }

    this.eventCatalogDirectory = eventCatalogDirectory;
    this.hookdeckApiKey = hookdeckApiKey;

    this.hookdeckClient = new HookdeckClient({ token: this.hookdeckApiKey });

    // For the moment, versions are created for each generation run
    // In the future:
    // 1. a version could be inferred from the schema though this has been tested
    //    and proved to be unreliable with property values being null or a string signalling a new schema.
    // 2. a version could be passed in as a parameter to the generator
    this.generationRunDate = new Date();
    this.processMaxEvents = options.processMaxEvents || 200;
  }

  async generate() {
    const { options } = this;

    // EventCatalog SDK (https://www.eventcatalog.dev/docs/sdk)
    const { writeDomain } = utils(this.eventCatalogDirectory);

    if (options.domain) {
      writeDomain({
        id: options.domain,
        name: options.domain,
        version: generateVersion(this.generationRunDate),
        markdown: '',
      });
    }

    const connectionsResponse = await this.hookdeckClient.connection.list();
    if (connectionsResponse.models !== undefined && connectionsResponse.models.length === 0) {
      this.logger.info('No connections found');
      return;
    }

    let connections = connectionsResponse.models!;
    const connectionSourceMatch = options.connectionSourcedMatch ? new RegExp(options.connectionSourcedMatch) : undefined;
    if (connectionSourceMatch) {
      this.logger.info(`Applying Connection Source Match: "${connectionSourceMatch}"`);
      this.logger.debug(connectionSourceMatch);

      connections = connections.filter((c) => {
        if (connectionSourceMatch && connectionSourceMatch.test(c.source.name) === false) {
          this.logger.debug(`Connection "${c.source.name}" does not match "${connectionSourceMatch}"`);
          return false;
        }
        return true;
      });
    }

    this.logger.info(`Found ${connections.length} connections`);
    this.logger.debug(
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
    //   this.logger.debug('Exiting early due to debug flag');
    //   return;
    // }

    await this.processSources(sources);

    await this.processDestinations(destinations);
  }

  private async processDestinations(destinations: { [key: string]: Destination }) {
    const { writeService, getService, writeEvent, getEvent, addEventToService, addServiceToDomain } = utils(
      this.eventCatalogDirectory
    );
    for (const destination of Object.values(destinations)) {
      // const destinationVersion = generateVersion(destination.updatedAt);
      const destinationVersion = generateVersion(this.generationRunDate);
      const existingSourceService = await getService(destination.id, destinationVersion);

      if (!existingSourceService) {
        // Create a Service for each Source
        await writeService({
          id: destination.id,
          name: destination.name,
          version: destinationVersion,
          markdown: destination.description || '',
        });

        if (this.options.domain) {
          await addServiceToDomain(this.options.domain, {
            id: destination.id,
            version: destinationVersion,
          });
        }
      } else {
        this.logger.debug(`Service or Destination ${destination.name} already exists`);
      }

      let nextEvent = undefined;
      let eventIteration = 1;
      const processedEvents = new Map<string, boolean>();
      do {
        const events = await this.hookdeckClient.event.list({ destinationId: destination.id, next: nextEvent });
        if (events.models) {
          this.logger.debug(`Found ${events.models.length} Events for Destination ${destination.id}`);

          for (let i = 0; i < events.models.length; ++i) {
            const event = events.models[i];

            if (processedEvents.has(event.id)) {
              throw new Error(`Event ID ${event.id} has already been processed`);
            }
            processedEvents.set(event.id, true);

            // Try to avoid rate limiting
            await sleep(SLEEP_TIME);

            const fullEvent = await this.hookdeckClient.event.retrieve(event.id);
            let eventType = `${destination.id}:${i}`;
            let schema = undefined;

            if (fullEvent.data) {
              this.logger.debug(
                `Processing Event ID "${event.id}". ${i + 1} of ${events.models.length}. Iteration: ${eventIteration}. Processed ${processedEvents.size} of a maximum ${this.processMaxEvents} events.`
              );

              // Create schema
              this.logger.trace(`Event ID: ${fullEvent.id} %s`, JSON.stringify(fullEvent.data));
              try {
                schema = createSchema(fullEvent.data.body);
                this.logger.trace(`Schema for Event ID: ${fullEvent.id} %s`, JSON.stringify(schema));
              } catch (e) {
                this.logger.error(`Error generating schema for Event ID: ${fullEvent.id} %s`, e);
              }

              // Try to determine an event type
              if (fullEvent.data.body && typeof fullEvent.data.body === 'object') {
                if ('type' in fullEvent.data.body) {
                  eventType = fullEvent.data.body.type as string;
                } else if ('eventType' in fullEvent.data.body) {
                  eventType = fullEvent.data.body.eventType as string;
                } else {
                  this.logger.warn(
                    `Could not determine event type. No 'type' or 'eventType' field found in Event ID: ${event.id}`
                  );
                }
              }
            } else {
              this.logger.error(`fullEvent.data is undefined for Event ID: ${event.id}`);
            }

            // const eventVersion = generateVersion(fullEvent.createdAt);
            const eventVersion = generateVersion(this.generationRunDate);
            const existingEvent = await getEvent(eventType, eventVersion);

            // EventCatalog does not support "." in event IDs
            const eventId = eventType.replace('.', EVENT_ID_SEPARATOR);

            if (!existingEvent) {
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
${JSON.stringify(fullEvent.data?.body, null, 2)}
\`\`\`

#### Headers

\`\`\`json
${JSON.stringify(fullEvent.data?.headers, null, 2)}
\`\`\`

### Meta

Event ID: ${fullEvent.id}
`,
                name: eventType,
                version: eventVersion,
              });

              this.logger.debug(`Written event for Event: ${JSON.stringify(fullEvent)}`);
            } else {
              this.logger.debug(`Event ${eventType} already exists`);
            }

            await addEventToService(destination.id, 'receives', {
              id: eventId,
              version: eventVersion,
            });

            this.logger.trace(`Registered eventType ${eventType} for service ${destination.name} for Event ID: ${event.id}`);
          }
        }

        nextEvent = events.pagination?.next;
        ++eventIteration;
      } while (processedEvents.size < this.processMaxEvents && nextEvent !== undefined);
    }

    this.logger.info(chalk.green(`Created Services for ${Object.keys(destinations).length} Destinations`));
  }

  private async processSources(sources: { [key: string]: Source }) {
    const { writeService, getService, writeEvent, getEvent, addEventToService, addServiceToDomain } = utils(
      this.eventCatalogDirectory
    );

    for (const source of Object.values(sources)) {
      // const serviceVersion = generateVersion(source.updatedAt);
      const serviceVersion = generateVersion(this.generationRunDate);
      const existingSourceService = await getService(source.id, serviceVersion);

      if (!existingSourceService) {
        // Create a Service for each Destination
        await writeService({
          id: source.id,
          name: source.name,
          version: serviceVersion,
          markdown: source.description || '',
        });

        if (this.options.domain) {
          await addServiceToDomain(this.options.domain, {
            id: source.id,
            version: serviceVersion,
          });
        }
      } else {
        this.logger.debug(`Service for Source ${source.name} already exists`);
      }

      let nextRequest = undefined;
      let requestIteration = 1;
      const processedRequests = new Map<string, boolean>();
      do {
        const requests = await this.hookdeckClient.request.list({ sourceId: source.id, next: nextRequest });
        if (requests.models) {
          this.logger.debug(`Found ${requests.models.length} Requests for Source ${source.id}`);

          for (let i = 0; i < requests.models.length; ++i) {
            const request = requests.models[i];

            if (processedRequests.has(request.id)) {
              throw new Error(`Request ID ${request.id} has already been processed`);
            }
            processedRequests.set(request.id, true);

            // Try to avoid rate limiting
            await sleep(SLEEP_TIME);

            const fullRequest = await this.hookdeckClient.request.retrieve(request.id, { maxRetries: 1 });
            let eventType = `${source.id}:${i}`;
            let schema: Schema | undefined = undefined;

            if (fullRequest.data) {
              // Create schema
              this.logger.debug(
                `Processing Request ID "${request.id}". ${i + 1} of ${requests.models.length}. Iteration: ${requestIteration}. Processed ${processedRequests.size} of a maximum ${this.processMaxEvents} requests.`
              );
              this.logger.trace(`Request ID: ${request.id} %s`, JSON.stringify(fullRequest.data));
              try {
                schema = createSchema(fullRequest.data.body);
                this.logger.trace(`Schema for Request ID: ${request.id} %s`, JSON.stringify(schema));
              } catch (e) {
                this.logger.error(`Error generating schema for Request ID: ${request.id} %s`, e);
              }

              // Try to determine an event type
              if (fullRequest.data.body && typeof fullRequest.data.body === 'object') {
                if ('type' in fullRequest.data.body) {
                  eventType = fullRequest.data.body.type as string;
                } else if ('eventType' in fullRequest.data.body) {
                  eventType = fullRequest.data.body.eventType as string;
                } else {
                  this.logger.warn(
                    `Could not determine event type. No 'type' or 'eventType' field found in Request ID: ${request.id}`
                  );
                }
              }
            } else {
              this.logger.error(`fullRequest.data is undefined for request ID: ${request.id}`);
              throw new Error(`fullRequest.data is undefined for request ID: ${request.id}`);
            }

            // const eventVersion = generateVersion(request.createdAt);
            const eventVersion = generateVersion(this.generationRunDate);
            const existingEvent = await getEvent(eventType, eventVersion);

            // EventCatalog does not support "." in event IDs
            const eventId = eventType.replace('.', EVENT_ID_SEPARATOR);

            if (!existingEvent) {
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

### Meta

Request ID: ${fullRequest.id}
`,
                name: eventType,
                version: eventVersion,
              });

              this.logger.debug(`Written event for Request: ${JSON.stringify(request)}`);

              await addEventToService(source.id, 'sends', {
                id: eventId,
                version: eventVersion,
              });

              this.logger.trace(`Registered eventType ${eventType} for service ${source.name} for Request ID: ${request.id}`);
            } else {
              this.logger.debug(`Event ${eventType} already exists`);
            }
          }
        }
        nextRequest = requests.pagination?.next;
        ++requestIteration;
      } while (processedRequests.size < this.processMaxEvents && nextRequest !== undefined);
    }

    this.logger.info(chalk.green(`Created Services for ${Object.keys(sources).length} Sources`));
  }
}

export default async (config: EventCatalogConfig, options: GeneratorProps) => {
  const generator = new Generator(config, options);
  await generator.generate();
};
