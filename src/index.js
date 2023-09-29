import express from 'express';
import { Codec, KeyManager, deriveSeedFrom } from '@holo-host/cryptolib'
import EnvoyApi from './envoyApi.js'; // Update with actual import if required
import * as dotenv from 'dotenv';
import CloudflareKV from './kvstore.js';

const app = express();
const port = 3000;

// Load environment variables from .env file
dotenv.config();
const accountId = process.env.ACCOUNT_ID;
const happ2hrlId = process.env.HAPP2HRL;
const happ2hostId = process.env.HAPP2HOST;
const apiToken = process.env.API_TOKEN;

if (!accountId || !happ2hrlId || !happ2hostId || !apiToken) {
  throw new Error('Environment variables ACCOUNT_ID, HAPP2HRL, HAPP2HOST, and API_TOKEN are required');
}

// Create a CloudflareKV instances for each KV namespace
const happ2hrlKV = new CloudflareKV(accountId, happ2hrlId, apiToken);
const happ2hostKV = new CloudflareKV(accountId, happ2hostId, apiToken);

async function fetchRoleAndZome(happ_id) {
  const value = await happ2hrlKV.get(happ_id);
  console.log(`Fetched role and zome for happ_id: ${happ_id}`);
  return JSON.parse(value);
}

async function fetchHostUrl(happId) {
  const keys = await happ2hostKV.listKeys(`${happId}`);
  console.log(`Fetched keys: ${JSON.stringify(keys)}`);
  const randomKey = keys[Math.floor(Math.random() * keys.length)];
  const host_url = await happ2hostKV.get(randomKey);
  console.log(`Fetched host_url: ${host_url}`);
  return host_url;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/:happ_id/:token_id', async (req, res) => {
  const { happ_id, token_id } = req.params;
  console.log(`Processing request for happ_id: ${happId}`);
  
  const { role_name, zome_name, fn_name } = await fetchRoleAndZome(happ_id);
  const hostId = await fetchHostUrl(happ_id);
  const host_url = `${hostId}.holohost.dev`;
  
  console.log(`Role: ${role_name}`);
  console.log(`Zome: ${zome_name}`);
  console.log(`Fn: ${fn_name}`);
  console.log(`Host URL: ${host_url}`);
  
  console.log("Generating key pair");
  const hha_id = new Uint8Array([
    66, 123, 133, 136, 133,   6, 247, 116,
     4,  59,  43, 206, 131, 168, 123,  44,
    54,  52,   3,  53, 134,  75, 137,  43,
    63,  26, 216, 191,  67, 117,  38, 142
  ]);

  const seed = deriveSeedFrom(hha_id, 'example@holo.host', 'password');
  const key_pair = new KeyManager(seed); 
  
  console.log("Generating envoy api");
  const envoyApi = new EnvoyApi({
    host_url,
    key_pair,
    happ_id,
    is_anonymous: true,
    agent_id: Codec.AgentId.encode(key_pair.publicKey()), 
  });
  
  await delay(1000);
  
  console.log("Calling envoy api");
  const response = await envoyApi.zomeCall({
    zomeName: zome_name,
    fnName: fn_name,
    payload: token_id,
    roleName: role_name,
    cellId: null,
    capSecret: null,
  });

  envoyApi.close();
  
  console.log('Sending response:', response);
  res.json(response);
});

app.listen(port, () => {
  console.log(`Node.js app listening at http://localhost:${port}`);
});
