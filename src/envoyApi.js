import { randomNonce, getNonceExpiration, hashZomeCall } from '@holochain/client';
import { Codec, HHT, KeyPair } from '@holo-host/cryptolib';
const { EventEmitter } = require('events');
const WebSocket = require('isomorphic-ws');
const msgpack = require('@msgpack/msgpack');
const {
  msgpackDecodeFromBlob,
  serializeAndHash,
  getHostIdFromUrl,
  holoEncodeDnaHash,
} = require('./utils');

const HappConfig = {
  name: '',
  logo_url: undefined,
  publisher_name: '',
  registration_info_url: '',
  is_paused: false,
};

export default class EnvoyApi extends EventEmitter {
  
  constructor({ host_url, key_pair, happ_id, is_anonymous, agent_id }) {
    super();
    
    this.key_pair = key_pair;
    this.happ_id = happ_id;
    this.is_anonymous = is_anonymous;
    this.host_id = getHostIdFromUrl(host_url);

    this.zome_call_response_consumers = {};
    this.next_zome_call_id = 0;

    const scheme = process.env.CHAPERONE_CONFIG_SECURE_WS ? 'wss' : 'ws';

    this.envoy_ws = new WebSocket(
      `${scheme}://${host_url}/hosting/?agent=${agent_id}&happ=${happ_id}${
        is_anonymous ? '&anonymous' : ''
      }`
    );

    this.envoy_ws.onopen = () => this.emit('open');
    this.envoy_ws.onclose = () => this.emit('close');
    this.envoy_ws.onmessage = async (message) => {
      const decoded_message = await msgpackDecodeFromBlob(message.data);

      switch (decoded_message.type) {
        case 'app_status_changed':
          this.emit('app_status_changed', decoded_message.data);
          break;
        case 'signing_request':
          this.handleSigningRequest(decoded_message.data);
          break;
        case 'response':
          const { id, body } = decoded_message.data;
          this.zome_call_response_consumers[id](body);
          break;
        case 'signal':
          this.handleSignal(decoded_message.data);
          break;
        case 'happ_config':
          this.emit('happ_config', decoded_message.data.data);
          break;
        default:
          console.log('unknown message type', decoded_message);
      }
    };
  
    // keep alive heart beat
    this.heartbeat_interval = setInterval(() => {
      this.get_app_status()
    }, 30_000)
  }

  async get_app_status () {
    console.log('EnvoyApi: Getting app status')
    await this.sendRequest(app_status_request())
  }

  async install_app (membrane_proof) {
    console.log('EnvoyApi: Installing app', membrane_proof)
    await this.sendRequest(install_request(membrane_proof))
  }

  async enable_app () {
    console.log('EnvoyApi: Enabling app')
    await this.sendRequest(enable_request())
  }

  async zome_call (zome_call_args) {
    console.log('EnvoyApi: Making zome call', zome_call_args)
    const id = this.next_zome_call_id++ 

    const request = await zome_call_request({
      ...zome_call_args,
      key_pair: this.key_pair,
      hha_hash: this.happ_id,
      id,
      host_id: this.host_id
    })

    this.sendRequest(request)

    const body = await new Promise(resolve => {
      this.zome_call_response_consumers[id] = resolve
    })

    if (body.type === 'error') {
      return body
    } else {
      return {
        ...body,
        data: msgpack.decode(body.data)
      }
    }
  }

  async handleSigningRequest (signingRequest) {
    const { id, payload } = signingRequest

    const signature = this.key_pair.sign(payload)
    
    await this.sendRequest(
      signing_response_request({
        id,
        signature
      })
    )
  }

  async handleSignal (envoy_signal) {
    // we decode the data here so that Agent.ts doesn't have to know about msgpack
    const data = msgpack.decode(envoy_signal.data)
    const dna_hash = envoy_signal.dna_hash
    const zome_name = envoy_signal.zome_name

    this.emit('signal', {
      data,
      dna_hash,
      zome_name
    })
  }

  sendRequest(request) {
    this.envoy_ws.send(request)
  }

  close () {
    clearInterval(this.heartbeat_interval)
    this.envoy_ws.close()
    this.removeAllListeners()
  }
}

// utils

// specific envoy request messages

const app_status_request = () =>
  msgpack.encode({
    type: 'app_status',
    data: null
  })

const install_request = (membrane_proof) =>
  msgpack.encode({
    type: 'install_app',
    data: {
      membrane_proof: membrane_proof || null
    }
  })

const enable_request = () =>
  msgpack.encode({
    type: 'enable_app',
    data: null
  })

const signing_response_request = (signing_response) =>
  msgpack.encode({
    type: 'signing_response',
    data: signing_response
  })

const zome_call_request = async ({
  zome_name,
  fn_name,
  payload,
  role_name,
  cell_id,
  cap_secret,
  key_pair,
  hha_hash,
  id,
  host_id
}) => {
  const args_hash = await serializeAndHash(payload)

  // hha_hash is deserialized as an ActionHash and must be sent as bytes
  const hha_hash_bytes = Codec.HoloHash.holoHashFromBuffer(HHT.HEADER, Codec.HoloHash.decode(hha_hash))

  // The order of these fields matters. Changing it will cause a signature validation error.
  const spec = {
    call_spec: {
      args_hash,
      function: fn_name,
      zome: zome_name,
      role_name,
      hha_hash: hha_hash_bytes
    },
    host_id,
    timestamp: Date.now() * 1000
  }

  const spec_bytes = msgpack.encode(spec)

  const spec_signature = key_pair.sign(spec_bytes)

  const signed_spec = {
    spec,
    signature: spec_signature
  }

  const encoded_payload = msgpack.encode(payload)

  const provenance = Codec.HoloHash.holoHashFromBuffer(HHT.AGENT, key_pair.publicKey())

  const nonce = await randomNonce()
  const expires_at = getNonceExpiration()

  const unsigned_zome_call_payload = {
    cap_secret: cap_secret || null,
    cell_id,
    zome_name,
    fn_name,
    provenance,
    payload: encoded_payload,
    nonce,
    expires_at,
  }

  const hashed_zome_call = await hashZomeCall(unsigned_zome_call_payload)

  const zome_call_signature = await key_pair.sign(hashed_zome_call)

  const cell_dna_hash = holoEncodeDnaHash(cell_id[0])

  // TODO: add a type for this
  const request = {
    type: 'request',
    data: {
      id,
      body: {
        type: 'zome_call',
        data: {
          signed_spec,
          payload: encoded_payload,
          cell_dna_hash,
          cap_secret,
          signature: zome_call_signature,
          nonce,
          expires_at
        }
      }
    }
  }

  return msgpack.encode(request)
}
