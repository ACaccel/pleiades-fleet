import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { waitForMongoReady } from '../../src/infra/mongo/ready';

export async function waitForMongo(envFile: string, timeoutSeconds: number): Promise<void> {
  const uri = parse(readFileSync(envFile)).MONGO_URI;
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
    throw new Error('A valid MONGO_URI is required in the configured probe env file');
  await waitForMongoReady(uri, timeoutSeconds);
}
