import express, { Request, Response } from 'express';
import KeyPair from './keypair'; // Update with actual import if required
import EnvoyApi from './envoyApi'; // Update with actual import if required
import kvstore from 'kvstore'; // Hypothetical library, replace with actual import

const app = express();
const port = 3000;

interface RoleAndZome {
  role_name: string;
  zome_name: string;
  fn_name: string;
}

async function fetchRoleAndZome(happId: string): Promise<RoleAndZome> {
  const value = await kvstore.get('HAPP2HRL', happId);
  console.log(`Fetched role and zome for happ_id: ${happId}`);
  return JSON.parse(value);
}

async function fetchHostUrl(happId: string): Promise<string> {
  const keys: string[] = await kvstore.listKeys('HAPP2HOST', `${happId}`);
  console.log(`Fetched keys: ${JSON.stringify(keys)}`);
  const randomKey = keys[Math.floor(Math.random() * keys.length)];
  const hostUrl = await kvstore.get('HAPP2HOST', randomKey);
  console.log(`Fetched host_url: ${hostUrl}`);
  return hostUrl;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/:happId/:tokenId', async (req: Request, res: Response) => {
  const { happ_id, tokenId } = req.params;
  console.log(`Processing request for happ_id: ${happ_id}`);
  
  const { role_name, zome_name, fn_name } = await fetchRoleAndZome(happ_id);
  const hostId = await fetchHostUrl(happ_id);
  const host_url = `${hostId}.holohost.dev`;
  
  console.log(`Role: ${role_name}`);
  console.log(`Zome: ${zome_name}`);
  console.log(`Fn: ${fn_name}`);
  console.log(`Host URL: ${host_url}`);
  
  console.log("Generating key pair");
  const key_pair = new KeyPair(); // You may need to define types for KeyPair
  
  console.log("Generating envoy api");
  const envoyApi = new EnvoyApi({
    host_url,
    key_pair,
    happ_id,
    is_anonymous: true,
    agent_id: key_pair.agentId(), // You may need to define types for agentId
  });
  
  await delay(1000);
  
  console.log("Calling envoy api");
  const response = await envoyApi.zomeCall({
    zomeName: zome_name,
    fnName: fn_name,
    payload: tokenId,
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
