import { type CellId, type AppInfo, type InstalledCell, type CallZomeRequestUnsigned, randomNonce, getNonceExpiration, hashZomeCall } from '@holochain/client'
import { Codec, HHT, KeyPair } from '@holo-host/cryptolib'
const { EventEmitter } = require('events')
const WebSocket = require('isomorphic-ws')
const msgpack = require('@msgpack/msgpack')
const {
  msgpackDecodeFromBlob,
  serializeAndHash,
  getHostIdFromUrl,
  holoEncodeDnaHash
} = require('./utils')

type HappConfig = {
  name: string,
  logo_url?: string,
  publisher_name?: string,
  registration_info_url?: string,
  is_paused: boolean,
}

export default class EnvoyApi extends EventEmitter {
  
  zome_call_response_consumers: ZomeCallResponseConsumers
  next_zome_call_id: ZomeCallId
  envoy_ws: WebSocket
  host_id: string
  is_anonymous: boolean
  happ_id: string
  key_pair: KeyPair

  constructor ({ host_url, key_pair, happ_id, is_anonymous, agent_id }: EnvoyApiInput) {
    super()

    // There's some redundancy between this class and Agent. Specifically, from a seed we can get a keypair and agent id, so passing all
    // three is not strictly necessary. The alternative is to make multiple redundant relatively expensive cryptographic calls.
    this.key_pair = key_pair
    this.happ_id = happ_id
    this.is_anonymous = is_anonymous
    this.host_id = getHostIdFromUrl(host_url)

    this.zome_call_response_consumers = {}
    this.next_zome_call_id = 0 as ZomeCallId

    const scheme = process.env.CHAPERONE_CONFIG_SECURE_WS ? 'wss' : 'ws'

    // consider renaming envoy_ws to ws
    this.envoy_ws = new WebSocket(
      `${scheme}://${host_url}/hosting/?agent=${agent_id}&happ=${happ_id}${
        is_anonymous ? '&anonymous' : ''
      }`
    )

    this.envoy_ws.onopen = () => this.emit('open')

    this.envoy_ws.onclose = () => this.emit('close')

    this.envoy_ws.onmessage = async message => {
      const decoded_message: EnvoyIncomingMessage = await msgpackDecodeFromBlob(message.data) as EnvoyIncomingMessage

      switch (decoded_message.type) {
        case 'app_status_changed':
          this.emit('app_status_changed', decoded_message.data)
          break
        case 'signing_request':
          this.handleSigningRequest(decoded_message.data)
          break
        case 'response':
          const { id, body } = decoded_message.data
          this.zome_call_response_consumers[id](body)
          break
        case 'signal':
          this.handleSignal(decoded_message.data)
          break
        case 'happ_config':
          this.emit('happ_config', decoded_message.data.data)
          break
        default:
          console.log('unknown message type', decoded_message)
      }
    }

    // keep alive heart beat
    this.heartbeat_interval = setInterval(() => {
      this.get_app_status()
    }, 30_000)
  }

  async get_app_status () {
    console.log('EnvoyApi: Getting app status')
    await this.sendRequest(app_status_request())
  }

  async install_app (membrane_proof: Buffer) {
    console.log('EnvoyApi: Installing app', membrane_proof)
    await this.sendRequest(install_request(membrane_proof))
  }

  async enable_app () {
    console.log('EnvoyApi: Enabling app')
    await this.sendRequest(enable_request())
  }

  async zome_call (zome_call_args: ZomeCallArgs) {
    console.log('EnvoyApi: Making zome call', zome_call_args)
    const id = this.next_zome_call_id++ as ZomeCallId

    const request = await zome_call_request({
      ...zome_call_args,
      key_pair: this.key_pair,
      hha_hash: this.happ_id,
      id,
      host_id: this.host_id
    })

    this.sendRequest(request)

    const body = await new Promise<ZomeCallResponseBody>(resolve => {
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

  async handleSigningRequest (signingRequest: SigningRequest) {
    const { id, payload } = signingRequest

    const signature = this.key_pair.sign(payload)
    
    await this.sendRequest(
      signing_response_request({
        id,
        signature
      })
    )
  }

  async handleSignal (envoy_signal: EnvoySignal) {
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

  sendRequest(request: EnvoyOutgoingMessageSerialized) {
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

const app_status_request = (): EnvoyOutgoingMessageSerialized =>
  msgpack.encode({
    type: 'app_status',
    data: null
  })

const install_request = (membrane_proof): EnvoyOutgoingMessageSerialized =>
  msgpack.encode({
    type: 'install_app',
    data: {
      membrane_proof: membrane_proof || null
    }
  })

const enable_request = (): EnvoyOutgoingMessageSerialized =>
  msgpack.encode({
    type: 'enable_app',
    data: null
  })

const signing_response_request = (signing_response: { id: SigningRequestId, signature: Uint8Array }): EnvoyOutgoingMessageSerialized =>
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
}): Promise<EnvoyOutgoingMessageSerialized> => {
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

  const unsigned_zome_call_payload: CallZomeRequestUnsigned = {
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

type ZomeCallArgs = {
  zome_name: string
  fn_name: string
  payload: any
  role_name: string
  cell_id: CellId
  cap_secret: any
}

type AppStatus = {
  type: 'not_installed'
} | {
  type: 'installing'
} | {
  type: 'installed',
  data: AppInfo
} | {
  type: 'error_installing',
  data: string
} | {
  type: 'not_hosted'
} | {
  type: 'paused'
} | {
  type: 'error_getting_app_info',
  data: String
} | {
  type: 'error_enabling',
  data: String
}

// explanation of this pattern https://kubyshkin.name/posts/newtype-in-typescript/ 
type ZomeCallId = number & { readonly __tag: unique symbol}

type ZomeCallResponse = {
  id: ZomeCallId,
  body: ZomeCallResponseBody
}

// explanation of this pattern https://kubyshkin.name/posts/newtype-in-typescript/ 
type SigningRequestId = unknown & { readonly __tag: unique symbol}

type SigningRequest = {
  id: SigningRequestId
  payload: Uint8Array
}

type ZomeCallResponseBody = {
  type: 'ok'
  data: any
} | {
  type: 'error'
  data: string
}

type ZomeCallResponseConsumers = {
  [key: ZomeCallId]: (value: ZomeCallResponseBody | PromiseLike<ZomeCallResponseBody>) => void
}

// The signal as we get it from envoy
type EnvoySignal = {
  data: Uint8Array
  dna_hash: Uint8Array
  zome_name: string
}

// The signal we emit to web-sdk
type HoloSignal = {
  data: any
  cell: InstalledCell,
  zome_name: string
}

// ALERT: This is Incoming wrt Chaperone. It is equivalent to OutgoingMessage in the envoy rust code, as it is outgoing wrt Envoy
type EnvoyIncomingMessage = {
  type: 'signal'
  data: EnvoySignal
} | {
  type: 'response' 
  data: ZomeCallResponse
} | {
  type: 'happ_config'
  data: {
    data: HappConfig
  }
} | {
  type: 'app_status_changed'
  data: AppStatus
} | {
  type: 'signing_request'
  data: SigningRequest
}

type EnvoyApiInput = {
  host_url: string,
  key_pair: KeyPair,
  happ_id: string,
  is_anonymous: boolean,
  agent_id: string
}

type EnvoyOutgoingMessageSerialized = Uint8Array & { readonly __tag: unique symbol}