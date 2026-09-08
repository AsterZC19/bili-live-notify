import { EnvHttpProxyAgent, fetch } from 'undici';
import { RemoteError } from './model.js';
import https from 'node:https';
import type { ClientRequest, RequestOptions } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

export const dispatcher = new EnvHttpProxyAgent();
// @discordjs/ws uses Node's default HTTPS agent without exposing a per-socket agent.
// Route that agent per URL, including resumed Gateway hosts and NO_PROXY exclusions.
type AgentWithRequest = https.Agent & { addRequest(req: ClientRequest, options: RequestOptions): void };
const directAgent = https.globalAgent as AgentWithRequest;
const proxyAgents = new Map<string, HttpsProxyAgent<string>>();
class GatewayAgent extends https.Agent {
  addRequest(req: ClientRequest, options: RequestOptions): void {
    const host = options.hostname ?? options.host ?? 'localhost';
    const proxy = getProxyForUrl(`https://${host}:${options.port ?? 443}`);
    if (!proxy) { directAgent.addRequest(req, options); return; }
    let agent = proxyAgents.get(proxy);
    if (!agent) { agent = new HttpsProxyAgent(proxy); proxyAgents.set(proxy, agent); }
    (agent as unknown as AgentWithRequest).addRequest(req, options);
  }
}
export function configureGatewayProxy() { https.globalAgent = new GatewayAgent(); }
export async function request(url: string, options: {
  method?: string; headers?: Record<string, string>; body?: string; timeout?: number; signal?: AbortSignal;
} = {}) {
  try {
    return await fetch(url, { ...options, dispatcher,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 8000)])
        : AbortSignal.timeout(options.timeout ?? 8000) });
  } catch {
    // Fetch errors can embed URLs containing bot credentials. Never log them.
    throw new RemoteError('网络请求失败或超时');
  }
}
export async function closeNetwork() {
  for (const agent of proxyAgents.values()) agent.destroy();
  https.globalAgent.destroy(); https.globalAgent = directAgent;
  await dispatcher.close();
}
