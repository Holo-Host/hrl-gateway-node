import * as ed from './ed25519';
import { Codec } from './cryptolib'

export default class KeyPair {
    pubKey
    privateKey

    constructor () {
        this.privateKey = new Uint8Array([
            1, 2, 3, 4, 5, 6, 7, 8,
            9, 10, 11, 12, 13, 14, 15, 16,
            17, 18, 19, 20, 21, 22, 23, 24,
            25, 26, 27, 28, 29, 30, 31, 32
        ])
        this.pubKey = ed.getPublicKey(this.privateKey)
    }

    sign (msg) {
        return ed.sign(msg, this.privateKey)
    }

    publicKey () {
        return this.pubKey
    }

    agentId () {
        return Codec.AgentId.encode(this.pubKey)
    }
}