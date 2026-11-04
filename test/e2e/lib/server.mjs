import { Buffer } from 'node:buffer';

/**
 * Paths inside the code-server container, as test/e2e/server/supervisor.mjs sets them up. The user data directory
 * is the default one of code-server, on a Docker volume.
 */
export const PROJECT = '/home/coder/project';
export const FIXTURES = `${PROJECT}/fixtures`;
export const USER_DATA = '/home/coder/.local/share/code-server';
export const USER_SETTINGS = `${USER_DATA}/User/settings.json`;
/** Where code-server keeps machine-scoped settings such as `aantje.connections`. */
export const MACHINE_SETTINGS = `${USER_DATA}/Machine/settings.json`;
/** The folder of the extensions that are installed in the container, one `<publisher>.<name>-<version>` each. */
export const EXTENSIONS = '/home/coder/extensions';

/**
 * Parses JSON with comments and trailing commas, which is what VS Code writes and reads for its settings files.
 * Comments inside strings (`"http://..."`) stay.
 */
export function parseJsonc(text) {
  const string = /"(?:\\.|[^"\\])*"/.source;
  const comment = /\/\/[^\n]*|\/\*[\s\S]*?\*\//.source;
  const withoutComments = text.replace(
    new RegExp(`(${string})|${comment}`, 'g'),
    (_match, kept) => kept ?? '',
  );
  const trailingComma = new RegExp(`(${string})|,(\\s*[}\\]])`, 'g');
  return JSON.parse(withoutComments.replace(trailingComma, (_match, kept, closer) => kept ?? closer));
}

const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Client of the control API that the supervisor offers inside the code-server container. A spec reaches it as
 * `t.server`. The commands run in the container, not in the browser, and one at a time.
 */
export function serverControl(base) {
  async function call(method, path, body) {
    const response = await globalThis.fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}: ${payload.error}`);
    }
    return payload;
  }

  /** Runs a shell command as the user coder. Resolves to { code, stdout, stderr }; a failing command does not throw. */
  const exec = (command) => call('POST', '/exec', { command });

  async function readFile(path) {
    const { code, stdout, stderr } = await exec(`cat -- ${quote(path)}`);
    if (code !== 0) {
      throw new Error(`Cannot read ${path}: ${stderr.trim()}`);
    }
    return stdout;
  }

  return {
    exec,
    readFile,

    /**
     * Stops and starts code-server, and with it the extension host, like the restart of the container of the
     * workbench does. User data and project folder stay. Open the workbench again afterwards.
     */
    restart: () => call('POST', '/restart'),

    /**
     * Like `restart`, but from the state of a new container: an empty user data directory with the default settings of
     * the harness, fresh copies of the fixtures, and the extension installed again. The runner does this
     * before every spec.
     */
    reset: () => call('POST', '/reset'),

    /** A settings or other JSON file of the container, comments allowed. Throws when it cannot be read. */
    async readJson(path) {
      return parseJsonc(await readFile(path));
    },

    /** Writes a file in the container, as the user coder, and creates the folder when it is missing. */
    async writeFile(path, text) {
      const encoded = Buffer.from(text).toString('base64');
      const folder = path.slice(0, path.lastIndexOf('/'));
      const { code, stderr } = await exec(
        `mkdir -p -- ${quote(folder)} && printf %s ${quote(encoded)} | base64 -d > ${quote(path)}`,
      );
      if (code !== 0) {
        throw new Error(`Cannot write ${path}: ${stderr.trim()}`);
      }
    },

    /** The SHA-256 of a file in the container as lower-case hex. */
    async sha256(path) {
      const { code, stdout, stderr } = await exec(`sha256sum -- ${quote(path)}`);
      if (code !== 0) {
        throw new Error(`Cannot hash ${path}: ${stderr.trim()}`);
      }
      return stdout.split(' ')[0];
    },

    /**
     * The installed extension with this id (`teitelberg.aantje`) as { dir, manifest }: its folder and its parsed
     * package.json. Throws when it is not installed.
     */
    async installedExtension(id) {
      if (!/^[\w-]+\.[\w-]+$/.test(id)) {
        throw new Error(`"${id}" is not an extension id (<publisher>.<name>)`);
      }
      const { stdout } = await exec(`ls -d ${EXTENSIONS}/${id}-* 2>/dev/null | head -n 1`);
      const dir = stdout.trim();
      if (!dir) {
        throw new Error(`${id} is not installed in ${EXTENSIONS}`);
      }
      return { dir, manifest: JSON.parse(await readFile(`${dir}/package.json`)) };
    },

    /**
     * The newest log file of the extension host with this name, for example 'teitelberg.aantje/aantje.log' (the
     * "aantje" output channel). Empty when there is none yet.
     */
    async readLog(name) {
      const { stdout } = await exec(
        `file=$(find ${USER_DATA}/logs -path ${quote(`*/${name}`)} -printf '%T@ %p\\n' | sort -n | tail -n 1 | cut -d' ' -f2-); [ -n "$file" ] && cat -- "$file"; true`,
      );
      return stdout;
    },
  };
}
