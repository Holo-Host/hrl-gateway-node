import axios from 'axios';

class CloudflareKV {
  constructor(accountId, namespaceId, apiToken) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
    this.headers = {
      Authorization: `Bearer ${apiToken}`,
    };
  }

  async get(key) {
    const url = `${this.baseUrl}/values/${encodeURIComponent(key)}`;

    try {
      const response = await axios.get(url, { headers: this.headers });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error getting key value:', error);
      return { success: false, error: error.response ? error.response.data : 'Unknown error' };
    }
  }

  async listKeys(prefix) {
    let url = `${this.baseUrl}/keys`;

    if (prefix) {
      url += `?prefix=${encodeURIComponent(prefix)}`;
    }

    try {
      const response = await axios.get(url, { headers: this.headers });
      return { success: true, data: response.data.result.map(keyObj => keyObj.name) };
    } catch (error) {
      console.error('Error listing keys:', error);
      return { success: false, error: error.response ? error.response.data : 'Unknown error' };
    }
  }
}

export default CloudflareKV;
