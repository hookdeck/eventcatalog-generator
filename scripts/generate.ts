#!/usr/bin/env node

import 'dotenv/config';
import generator, { EventCatalogConfig } from '../src/index.ts';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

const config: EventCatalogConfig = {
  // Populate the config object with the necessary properties
};

if (args.debug) {
  console.log('Generate with args', { args });
}

function printHelp() {
  console.log(
    `Usage:
    
    generate
      [--api-key <hookdeck-api-key>] 
      [--dir <project-dir>] 
      [--domain <domain>] 
      [--max-events <max-events>] 
      [--log-level <log-level>] 
      [--match <match>]`
  );
}

if (args.help) {
  printHelp();
  process.exit(0);
}

generator(config, {
  logLevel: args['log-level'],
  connectionSourcedMatch: args.match,
  projectDir: args.dir,
  hookdeckApiKey: args['api-key'],
  domain: args.domain,
  processMaxEvents: args['max-events'],
}).catch((error: Error) => {
  console.error('Error generating event catalog', error.message);
  printHelp();

  process.exit(1);
});
