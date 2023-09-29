import * as msgpack from '@msgpack/msgpack';
import SerializeJSON from 'json-stable-stringify';
import { writable } from 'svelte/store';
import crypto from 'crypto';
import { Codec } from '@holo-host/cryptolib';

// this can be removed if we set binary type of ws connection to "arrayBuff"
export async function msgpackDecodeFromBlob(buffer) {
  if (Buffer.isBuffer(buffer)) {
    return msgpack.decode(buffer);
  } else {
    console.error('Input is not a Buffer:', buffer);
    // Handle the error as appropriate for your application
  }
}

export function serializeAndHash(payload) {
  const serialized_args = SerializeJSON(payload);
  return sha256(Buffer.from(serialized_args, 'utf8'));
}

export function getHostIdFromUrl(host_url) {
  const components = host_url.split('.');
  if (components.length > 2) {
    // a real domain containing the host pubkey
    return components[0];
  } else {
    // a localhost domain
    return 'mock_host_id_string';
  }
}

// This should be handled entirely by cryptolib, but it doesn't quite play nice
export function holoEncodeDnaHash(dna_hash) {
  const url_unsafe = 'u' + Codec.Signature.encode(Buffer.from(dna_hash));
  return convert_b64_to_holohash_b64(url_unsafe);
}

function convert_b64_to_holohash_b64(rawBase64) {
  let holoHashbase64 = '';
  const len = rawBase64.length;
  for (let i = 0; i < len; i++) {
    let char = rawBase64[i];
    if (char === '/') {
      char = '_';
    } else if (char === '+') {
      char = '-';
    }
    holoHashbase64 += char;
  }
  return holoHashbase64;
}

const sha256 = async buffer => {
  if (crypto.subtle === undefined) {
    return crypto
      .createHash('sha256')
      .update(buffer)
      .digest();
  } else {
    return Buffer.from(await crypto.subtle.digest('SHA-256', buffer));
  }
}
