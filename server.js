'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(process.env.REPOS_DIR || '/data');
const API_TOKEN = process.env.GIT_API_TOKEN || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const activeRepos = new Set();

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const header = req.headers.authorization || '';
  return Boolean(API_TOKEN) && header === `Bearer ${API_TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk.toString();
      if (raw.length > 32 * 1024) {
        reject(new Error('Corpo da requisição excede 32 KB.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const value = raw ? JSON.parse(raw) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch {
        reject(new Error('Corpo JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function git(repoPath, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (GITHUB_TOKEN) {
      const encoded = Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${encoded}`;
    }

    const child = spawn('git', ['-c', `safe.directory=${repoPath}`, '-C', repoPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error((stderr || stdout || `Git encerrou com código ${code}`).trim()));
    });
  });
}

function validRepoName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';
}

async function getRepo(name) {
  if (!validRepoName(name)) throw Object.assign(new Error('Informe um nome de repositório válido.'), { status: 400 });
  const repoPath = path.resolve(ROOT, name);
  if (path.dirname(repoPath) !== ROOT) throw Object.assign(new Error('Caminho de repositório inválido.'), { status: 400 });
  const stat = await fs.stat(repoPath).catch(() => null);
  if (!stat || !stat.isDirectory()) throw Object.assign(new Error(`Repositório '${name}' não encontrado em /data.`), { status: 404 });
  const gitMarker = await fs.stat(path.join(repoPath, '.git')).catch(() => null);
  if (!gitMarker) throw Object.assign(new Error(`A pasta '${name}' não contém um repositório Git.`), { status: 400 });
  return repoPath;
}

async function handle(req, res) {
  if (!authorized(req)) return send(res, 401, { error: 'Token ausente ou inválido.' });

  const url = new URL(req.url, 'http://localhost');
  const action = url.pathname;
  const isInit = req.method === 'POST' && action === '/init';
  const isRead = req.method === 'GET' && ['/status', '/diff'].includes(action);
  const isWrite = req.method === 'POST' && ['/commit', '/push', '/pull'].includes(action);

  if (!isRead && !isWrite && !isInit) {
    return send(res, 404, { error: 'Endpoint não encontrado.' });
  }

  const body = (isWrite || isInit) ? await readBody(req) : {};
  const repoName = isRead ? url.searchParams.get('repo') : body.repo;

  if (isInit) {
    if (!validRepoName(repoName)) {
      throw Object.assign(
        new Error('Informe um nome de pasta válido.'),
        { status: 400 }
      );
    }

    const initPath = path.resolve(ROOT, repoName);

    if (path.dirname(initPath) !== ROOT) {
      throw Object.assign(
        new Error('Caminho de pasta inválido.'),
        { status: 400 }
      );
    }

    const stat = await fs.stat(initPath).catch(() => null);

    if (!stat || !stat.isDirectory()) {
      throw Object.assign(
        new Error(`Pasta '${repoName}' não encontrada em /data.`),
        { status: 404 }
      );
    }

    if (activeRepos.has(repoName)) {
      return send(res, 409, {
        error: `Já existe uma operação em andamento na pasta '${repoName}'.`
      });
    }

    activeRepos.add(repoName);

    try {
      const gitMarker = await fs.stat(path.join(initPath, '.git')).catch(() => null);

      if (gitMarker) {
        return send(res, 200, {
          repo: repoName,
          initialized: false,
          message: 'A pasta já é um repositório Git.'
        });
      }

      const result = await git(initPath, ['init', '-b', 'main']);

      return send(res, 200, {
        repo: repoName,
        initialized: true,
        result: result.stdout || result.stderr
      });
    } finally {
      activeRepos.delete(repoName);
    }
  }

  const repoPath = await getRepo(repoName);

  if (activeRepos.has(repoName)) return send(res, 409, { error: `Já existe uma operação em andamento no repositório '${repoName}'.` });
  activeRepos.add(repoName);
  try {
    if (action === '/status') {
      const result = await git(repoPath, ['status', '--short', '--branch']);
      return send(res, 200, { repo: repoName, status: result.stdout });
    }

    if (action === '/diff') {
      const unstaged = await git(repoPath, ['diff', '--']);
      const staged = await git(repoPath, ['diff', '--cached', '--']);
      return send(res, 200, { repo: repoName, unstaged: unstaged.stdout, staged: staged.stdout,
        note: 'Arquivos não rastreados aparecem em /status, mas não no diff até serem adicionados ao Git.' });
    }

    if (action === '/commit') {
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > 500) return send(res, 400, { error: 'Informe message com 1 a 500 caracteres.' });
      await git(repoPath, ['add', '-A']);
      const pending = await git(repoPath, ['status', '--porcelain']);
      if (!pending.stdout) return send(res, 200, { repo: repoName, committed: false, message: 'Não há alterações para commit.' });
      const result = await git(repoPath, ['commit', '-m', message]);
      return send(res, 200, { repo: repoName, committed: true, result: result.stdout });
    }

    if (action === '/push' || action === '/pull') {
      const remote = typeof body.remote === 'string' && /^[A-Za-z0-9._-]{1,50}$/.test(body.remote) ? body.remote : 'origin';
      if (action === '/pull') {
        const result = await git(repoPath, ['pull', '--ff-only', remote]);
        return send(res, 200, { repo: repoName, action: 'pull', result: result.stdout || result.stderr || 'OK' });
      }
      const result = await git(repoPath, ['push', remote]);
      return send(res, 200, { repo: repoName, action: 'push', result: result.stdout || result.stderr || 'OK' });
    }
  } finally {
    activeRepos.delete(repoName);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    const status = error.status || (/JSON inválido|excede 32 KB|Informe message|nome de repositório válido|Caminho de repositório inválido/.test(error.message) ? 400 : 500);
    send(res, status, { error: error.message || 'Erro interno.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Git API escutando na porta ${PORT}; raiz dos repositórios: ${ROOT}`);
});
