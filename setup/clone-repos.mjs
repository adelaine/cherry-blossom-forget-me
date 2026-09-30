import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { join } from 'node:path';

process.on('uncaughtException', error => {
  console.error(error.message);
  process.exitCode = 1;
});

const validateOnly = process.argv[2] === '--validate';
const certificatePathsOnly = process.argv[2] === '--certificate-paths';
const deploy = process.argv[2] === '--deploy';
const configPath = validateOnly ? process.argv[3] : '/config/suiteapps-to-install.json';
const tokenPath = '/tmp/suitecloud-gitlab-token';
const nemsFiles = ['/config/.nems.env', '/config/config.toml'];

function readToken(file) {
  if (!existsSync(file)) return '';
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  let section = '';
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) {
      section = heading[1].toLowerCase();
      continue;
    }
    const setting = (file.endsWith('.toml') &&
      line.match(/(?:^|[{,]\s*)((?:nems_)?gitlab_(?:(?:personal|private|access|api)_)?token)\s*=\s*("[^"]*"|'[^']*')/i))
      || line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/);
    if (!setting) continue;
    const key = setting[1].toLowerCase();
    const isGitlabToken = /^(?:nems_)?gitlab_(?:(?:personal|private|access|api)_)?token$/.test(key)
      || key === 'gitlab_pat'
      || key === 'gitlab.token'
      || (section === 'gitlab' && ['token', 'access_token', 'private_token', 'personal_access_token', 'pat'].includes(key));
    if (!isGitlabToken) continue;
    let value = setting[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (value) return value;
  }
  return '';
}

function promptForToken() {
  const result = spawnSync('bash', ['-c',
    'read -rsp "GitLab token: " token </dev/tty; printf "\\n" >/dev/tty; printf "%s" "$token"'
  ], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error('Could not read the GitLab token.');
  return result.stdout;
}

function invalidConfig(message) {
  throw new Error(`${message} Update suiteapps-to-install.json and run the start script again.`);
}

function gitlabHttpsUrl(raw) {
  if (typeof raw !== 'string') return null;
  let projectPath;
  const ssh = raw.match(/^git@gitlab\.eng\.netsuite\.com:([A-Za-z0-9._/-]+)$/i);
  if (ssh) {
    projectPath = ssh[1];
  } else {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'gitlab.eng.netsuite.com' ||
        parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    projectPath = parsed.pathname.slice(1);
  }
  projectPath = projectPath.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(projectPath)) return null;
  return `https://gitlab.eng.netsuite.com/${projectPath}.git`;
}

function validBranch(branch) {
  return typeof branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
    && !branch.includes('..') && !branch.includes('//')
    && !branch.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'));
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: {
    ...process.env,
    GIT_ASKPASS: '/usr/local/bin/gitlab-askpass.sh',
    GIT_TERMINAL_PROMPT: '0'
  }});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed.`);
}

function suitecloudEnv(passkey, deploying = false) {
  const env = { ...process.env, SUITECLOUD_CI_PASSKEY: passkey };
  delete env.SUITECLOUD_FALLBACK_PASSKEY;
  if (deploying) env.SUITECLOUD_CI = '1';
  else delete env.SUITECLOUD_CI;
  return env;
}

function runSuitecloud(args, cwd, passkey, deploying = false) {
  const result = spawnSync('suitecloud', args, { cwd, stdio: 'inherit', env: suitecloudEnv(passkey, deploying) });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`SuiteCloud ${args[0]} failed in ${cwd}.`);
}

function verifyCertificates() {
  const publicPath = '/config/certs/public.pem';
  const privatePath = '/config/certs/private.pem';
  if (!existsSync(publicPath) || !existsSync(privatePath)) {
    throw new Error('Certificate files were not mounted. Check their paths in suiteapps-to-install.json.');
  }
  try {
    const publicKey = new X509Certificate(readFileSync(publicPath)).publicKey.export({ type: 'spki', format: 'der' });
    const privateKey = createPublicKey(createPrivateKey(readFileSync(privatePath))).export({ type: 'spki', format: 'der' });
    if (!publicKey.equals(privateKey)) throw new Error('mismatch');
  } catch {
    throw new Error('The public and private certificate files do not match or cannot be read.');
  }
  return privatePath;
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  invalidConfig('The JSON file could not be read or has a syntax error.');
}
if (!config || !Array.isArray(config.suiteapps)) {
  invalidConfig('The file needs a "suiteapps" list.');
}
if (certificatePathsOnly || deploy) {
  const certs = config.certificates;
  const runbox = config.runbox;
  if (!certs || !['public', 'private'].every(key =>
    typeof certs[key] === 'string' && certs[key].trim() && !/[\r\n]/.test(certs[key]))) {
    invalidConfig('The "certificates" section needs public and private file paths.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(certs.id || '')) {
    invalidConfig('The "certificates" section needs the NetSuite certificate ID.');
  }
  if (!runbox || typeof runbox.account !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runbox.account) ||
      typeof runbox.url !== 'string' || !/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/.test(runbox.url) ||
      !runbox.url.endsWith('.netsuite.com')) {
    invalidConfig('The "runbox" section needs an account ID and a NetSuite domain.');
  }
}
if (config.suiteapps.length === 0 && !certificatePathsOnly) {
  console.log('There are no SuiteApps to install in suiteapps-to-install.json.');
  process.exit(0);
}

const seen = new Set();
for (const [index, repo] of config.suiteapps.entries()) {
  if (!repo || typeof repo !== 'object' || Array.isArray(repo) || !gitlabHttpsUrl(repo.url)) {
    invalidConfig(`SuiteApp ${index + 1} needs a GitLab HTTPS or SSH URL from gitlab.eng.netsuite.com.`);
  }
  if (typeof repo.directory !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo.directory) ||
      ['.', '..'].includes(repo.directory) || seen.has(repo.directory.toLowerCase())) {
    invalidConfig(`SuiteApp ${index + 1} needs a unique "directory" name without spaces or slashes.`);
  }
  if (repo.branch !== undefined && !validBranch(repo.branch)) {
    invalidConfig(`SuiteApp ${index + 1} has an invalid "branch" name.`);
  }
  seen.add(repo.directory.toLowerCase());
}

if (validateOnly) {
  const label = config.suiteapps.length === 1 ? 'SuiteApp is' : 'SuiteApps are';
  console.log(`${config.suiteapps.length} ${label} listed and valid.`);
  process.exit(0);
}
if (certificatePathsOnly) {
  console.log(config.certificates.public);
  console.log(config.certificates.private);
  process.exit(0);
}

const privateKeyPath = deploy ? verifyCertificates() : null;

try {
  const token = nemsFiles.map(readToken).find(Boolean) || promptForToken();
  if (!token) throw new Error('A GitLab token is required.');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  for (const repo of config.suiteapps) {
    const destination = join('/workspace', repo.directory);
    const cloneUrl = gitlabHttpsUrl(repo.url);
    if (existsSync(join(destination, '.git'))) {
      const remote = spawnSync('git', ['-C', destination, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
      if (remote.status !== 0 || gitlabHttpsUrl(remote.stdout.trim()) !== cloneUrl) {
        throw new Error(`${repo.directory} already contains a different SuiteApp.`);
      }
      if (repo.branch) {
        run('git', ['-C', destination, 'fetch', 'origin']);
        run('git', ['-C', destination, 'checkout', repo.branch]);
        run('git', ['-C', destination, 'pull', '--ff-only', 'origin', repo.branch]);
      }
      console.log(`Already copied: ${repo.directory}`);
    } else if (existsSync(destination)) {
      throw new Error(`${repo.directory} already exists but is not a Git checkout.`);
    } else {
      console.log(`Copying ${repo.directory}...`);
      try {
        run('git', ['clone', ...(repo.branch ? ['--branch', repo.branch] : []), cloneUrl, destination]);
        if (repo.branch) run('git', ['-C', destination, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
      } catch (error) {
        rmSync(destination, { recursive: true, force: true });
        throw error;
      }
    }
  }
  if (deploy) {
    const authId = `suitecontainer_${config.runbox.account}_${createHash('sha256').update(config.runbox.url).digest('hex').slice(0, 8)}`;
    const passkey = randomBytes(32).toString('hex');
    let authenticationReady = false;
    for (const repo of config.suiteapps) {
      const destination = join('/workspace', repo.directory);
      if (!existsSync(join(destination, 'manifest.xml')) || !existsSync(join(destination, 'deploy.xml'))) {
        throw new Error(`${repo.directory} needs manifest.xml and deploy.xml before deployment.`);
      }
      const cliConfig = join(destination, 'suitecloud.config.js');
      if (!existsSync(cliConfig)) {
        writeFileSync(cliConfig, "module.exports = { defaultProjectFolder: '.', commands: {} };\n");
      }
    }
    for (const repo of config.suiteapps) {
      const destination = join('/workspace', repo.directory);
      if (!authenticationReady) {
        const existing = spawnSync('suitecloud', ['account:manageauth', '--info', authId], { cwd: destination, stdio: 'ignore', env: suitecloudEnv(passkey) });
        if (existing.error) throw existing.error;
        if (existing.status === 0) {
          runSuitecloud(['account:setup:ci', '--select', authId], destination, passkey);
        } else {
          runSuitecloud([
            'account:setup:ci', '--account', config.runbox.account, '--authid', authId,
            '--certificateid', config.certificates.id, '--privatekeypath', privateKeyPath,
            '--domain', config.runbox.url
          ], destination, passkey);
        }
        authenticationReady = true;
      } else {
        runSuitecloud(['account:setup:ci', '--select', authId], destination, passkey);
      }
      console.log(`Checking ${repo.directory} against ${config.runbox.url}...`);
      runSuitecloud(['project:deploy', '--dryrun'], destination, passkey, true);
    }
    for (const repo of config.suiteapps) {
      const destination = join('/workspace', repo.directory);
      console.log(`Deploying ${repo.directory} to ${config.runbox.url}...`);
      runSuitecloud(['project:deploy'], destination, passkey, true);
    }
    console.log('All SuiteApps were deployed.');
  } else {
    console.log('Ready. Type exit when you are done.');
    run('bash', []);
  }
} finally {
  rmSync(tokenPath, { force: true });
}
