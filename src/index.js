import express from 'express';
import { Codec, KeyManager, deriveSeedFrom } from '@holo-host/cryptolib'
import EnvoyApi from './envoyApi.js'; // Update with actual import if required
import * as dotenv from 'dotenv';
import CloudflareKV from './kvstore.js';

const app = express();
const port = 3000;

// Load environment variables from .env file
const args = process.argv.slice(2);  // Skip `node` and script name.
let envFilePath;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env-file' && i + 1 < args.length) {
    envFilePath = args[i + 1];
    break;
  }
}
console.log(`Loading environment variables from ${envFilePath}`);
dotenv.config({ path: envFilePath });
const accountId = process.env.ACCOUNT_ID;
const happ2hrlId = process.env.HAPP2HRL;
const happ2hostId = process.env.HAPP2HOST;
const apiToken = process.env.API_TOKEN;

if (!accountId || !happ2hrlId || !happ2hostId || !apiToken) {
  throw new Error('Environment variables ACCOUNT_ID, HAPP2HRL, HAPP2HOST, and API_TOKEN are required');
}

const role_name = 'fractal_tribute'
const zome_name = 'fractal_tribute'
const fn_name = 'token_id_to_metadata'

// Create a CloudflareKV instances for each KV namespace
// const happ2hrlKV = new CloudflareKV(accountId, happ2hrlId, apiToken);
const happ2hostKV = new CloudflareKV(accountId, happ2hostId, apiToken);

// async function fetchRoleAndZome(happ_id) {
//   const value = await happ2hrlKV.get(happ_id);
//   console.log(`Fetched role and zome for happ_id: ${happ_id}`);
//   return JSON.parse(JSON.stringify(value));
// }

function h2d(s) {
  // Validate input
  if (typeof s !== 'string' || !s.match(/^[0-9a-fA-F]+$/)) {
      throw new Error("Invalid hexadecimal input.");
  }
  
  // Limit input length for performance considerations
  const MAX_LENGTH = 1000; // You can adjust this value as needed
  if (s.length > MAX_LENGTH) {
      throw new Error("Input is too long.");
  }

  function add(x, y) {
      var c = 0, r = [];
      var x = x.split('').map(Number);
      var y = y.split('').map(Number);
      while(x.length || y.length) {
          var s = (x.pop() || 0) + (y.pop() || 0) + c;
          r.unshift(s < 10 ? s : s - 10); 
          c = s < 10 ? 0 : 1;
      }
      if(c) r.unshift(c);
      return r.join('');
  }
  
  var dec = '0';
  s.split('').forEach(function(chr) {
      var n = parseInt(chr, 16);
      for(var t = 8; t; t >>= 1) {
          dec = add(dec, dec);
          if(n & t) dec = add(dec, '1');
      }
  });
  return dec;
}

async function fetchHostUrl(happ_id) {
  const keysResult = await happ2hostKV.listKeys(`${happ_id}`);

  if (!keysResult.success || !keysResult.data || keysResult.data.length === 0) {
    throw new Error(`Failed to fetch keys for happ_id ${happ_id}. Error: ${keysResult.error || 'No keys found'}`);
  }

  console.log(`Fetched keys: ${JSON.stringify(keysResult.data)}`);
  const randomKey = keysResult.data[Math.floor(Math.random() * keysResult.data.length)];

  const hostUrlResult = await happ2hostKV.get(randomKey);

  if (!hostUrlResult.success || !hostUrlResult.data) {
    throw new Error(`Failed to fetch host_url for key ${randomKey}. Error: ${hostUrlResult.error || 'No host_url found'}`);
  }

  console.log(`Fetched host_url: ${hostUrlResult.data}`);
  return hostUrlResult.data;
}


function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/:happ_id/:token_id', async (req, res) => {
  const { happ_id, token_id } = req.params;
  let token_id_bigint
  try {
    token_id_bigint = h2d(token_id);
  } catch (error) {
    console.error('Error converting token_id to bigint:', error.message);
    return res.status(400).json({ error: "Invalid token ID" });
  }
  console.log(`Processing request for happ_id: ${happ_id}`);
  let hostId
  try {
    hostId = await fetchHostUrl(happ_id);
    console.log('Successfully fetched host URL:', hostId);
  } catch (error) {
    console.error('Error fetching host URL:', error.message);
    return res.status(400).json({ error: "This application isn't registered for gateway requests"});
  }
  
  const host_url = `${hostId}.holohost.dev`;
  
  // console.log(`Role: ${role_name}`);
  // console.log(`Zome: ${zome_name}`);
  // console.log(`Fn: ${fn_name}`);
  // console.log(`Host URL: ${host_url}`);
  
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
  
  // await delay(1000);
  envoyApi.on('open', async () => {  
    console.log("Envoy api opened")
    try {
      console.log("Calling envoy api");
      const response = await envoyApi.zome_call({
        zome_name: zome_name,
        fn_name: fn_name,
        payload: token_id_bigint,
        role_name: role_name,
        cell_id: null,
        cap_secret: null,
      });
      
      envoyApi.close();

      console.log("Sending response")
      if (response.type === 'error' && response.data.includes("No game moves found for that token id")) {
        return res.status(404).json({ error: "Token ID not found" });
      }

      if (response.type === 'error' && response.data.includes("Could not parse token id")) {
        return res.status(400).json({ error: "Invalid token ID" });
      }

      res.json(JSON.parse(response.data))
    } catch (error) {
      console.error('Error during zome_call:', error);
      res.status(500).json({ error: 'Failed to process request.' });
    }
  });
});

app.listen(port, () => {
  console.log(`Node.js app listening at http://localhost:${port}`);
});
