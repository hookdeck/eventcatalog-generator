import 'dotenv/config';
import generator, { EventCatalogConfig } from '../src/index.ts';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

const config: EventCatalogConfig = {
  // Populate the config object with the necessary properties
};

if (args.debug) {
  console.log('Script args', { args });
}

generator(config, {
  debug: args.debug,
  connectionSourcedMatch: args.match,
  projectDir: args.dir,
  hookdeckApiKey: args['api-key'],
});
