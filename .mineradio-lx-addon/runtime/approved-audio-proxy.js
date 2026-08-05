'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const tokens = new Map();
let server;
let serverPort;

function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local')) return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function ensureUpstream(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('invalid approved upstream URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('approved upstream must use HTTP or HTTPS');
  if (isPrivateHost(url.hostname)) throw new Error('private or loopback upstream is not allowed');
  return url;
}

async function ensureServer() {
  if (server) return serverPort;
  server = http.createServer((request, response) => {
    const match = request.url?.match(/^\/approved-audio\/([^/?]+)$/);
    const entry = match ? tokens.get(match[1]) : null;
    if (!entry || entry.expiresAt < Date.now() || entry.uses >= entry.maxUses) { response.writeHead(404); response.end('revoked or expired'); return; }
    entry.uses += 1;
    const transport = entry.url.protocol === 'https:' ? https : http;
    const upstream = transport.request(entry.url, { method: 'GET', headers: request.headers.range ? { range: request.headers.range } : {} }, result => {
      const contentType = String(result.headers['content-type'] || '').toLowerCase();
      if (result.statusCode < 200 || result.statusCode >= 400 || contentType && !contentType.startsWith('audio/')) { response.writeHead(415); response.end('upstream is not audio'); result.resume(); return; }
      response.writeHead(result.statusCode, { 'content-type': result.headers['content-type'] || 'audio/mpeg', 'content-length': result.headers['content-length'] || undefined, 'accept-ranges': result.headers['accept-ranges'] || 'bytes' });
      let total = 0;
      result.on('data', chunk => { total += chunk.length; if (total > 64 * 1024 * 1024) upstream.destroy(new Error('proxy response too large')); else response.write(chunk); });
      result.on('end', () => response.end());
      result.on('error', () => response.destroy());
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('upstream request failed'); });
    upstream.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  serverPort = server.address().port;
  return serverPort;
}

async function createApprovedStream(candidate, request = {}) {
  if (!candidate || candidate.sourceKind !== 'lx-user-api' || candidate.completeness !== 'full') throw new Error('only full imported candidates can be proxied');
  if (candidate.sourceId !== request.sourceId || Number(candidate.generation) !== Number(request.generation) || candidate.songKey !== request.songKey) throw new Error('candidate identity mismatch');
  const url = ensureUpstream(candidate.upstreamUrl);
  const tokenId = crypto.randomBytes(18).toString('base64url');
  const port = await ensureServer();
  tokens.set(tokenId, { url, expiresAt: Date.now() + 30000, maxUses: 8, uses: 0, sourceId: candidate.sourceId, generation: candidate.generation, songKey: candidate.songKey });
  const proxyUrl = `http://127.0.0.1:${port}/approved-audio/${tokenId}`;
  return {
    proxyUrl,
    tokenId,
    async fetch() { const response = await globalThis.fetch(proxyUrl); if (!response.ok) throw new Error('token revoked or expired'); return response; }
  };
}

async function revokeApprovedStream(tokenId) { tokens.delete(tokenId); }

module.exports = { createApprovedStream, revokeApprovedStream, isPrivateHost };
