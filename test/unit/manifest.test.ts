import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { parseProfiles } from '../../src/connections/profile';
import { MAINTENANCE_LABEL } from '../../src/maintenance-labels';
import { existsExactCase } from '../support/docs';

const MAX_TIMEOUT_SECONDS = 86_400;

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

interface Manifest {
  name: string;
  displayName: string;
  homepage: string;
  version: string;
  engines: { vscode: string };
  extensionKind: string[];
  capabilities: Record<string, { supported: boolean; description?: string }>;
  publisher: string;
  author: { name: string };
  license: string;
  main: string;
  icon: string;
  activationEvents?: string[];
  contributes: {
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
    views: Record<string, { id: string }[]>;
    viewsWelcome: { view: string; contents: string }[];
    commands: { command: string; title?: string; category?: string; icon?: string; enablement?: string }[];
    keybindings?: { command: string; key: string; mac?: string; when?: string }[];
    submenus?: { id: string; label: string }[];
    menus: Record<string, MenuEntry[]>;
    configuration: {
      properties: Record<
        string,
        {
          scope?: string;
          default?: unknown;
          minimum?: number;
          maximum?: number;
          markdownDescription?: string;
          items?: {
            required: string[];
            properties: Record<string, { type?: string; default?: unknown; enum?: string[] }>;
          };
        }
      >;
    };
  };
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('package.json')) as Manifest;
const { commands, menus, views, viewsWelcome, viewsContainers, configuration } = manifest.contributes;
const submenus = manifest.contributes.submenus ?? [];

const commandIds = new Set(commands.map(({ command }) => command));
const viewIds = new Set(Object.values(views).flatMap((list) => list.map(({ id }) => id)));
const menuEntries = Object.entries(menus).flatMap(([menu, entries]) =>
  entries.map((entry) => ({ menu, ...entry })),
);
/** The entries that run a command; the others open a submenu. */
const commandEntries = menuEntries.flatMap(({ command, ...rest }) =>
  command === undefined ? [] : [{ command, ...rest }],
);
const settingIds = Object.keys(configuration.properties);
const profileProperties = configuration.properties['aantje.connections']?.items?.properties ?? {};

const sources = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({
    file: `src/${name.replaceAll('\\', '/')}`,
    text: read(`src/${name.replaceAll('\\', '/')}`),
  }));
const allSource = sources.map(({ text }) => text).join('\n');

/** What the tree provider sets as `contextValue`; the menu conditions are written against this list. */
const CONTEXT_VALUES = [
  'connection.disconnected',
  'connection.connected',
  'connection.error',
  'connection.disconnected.azure',
  'connection.connected.azure',
  'connection.error.azure',
  'schema',
  'schema.main',
  'table',
  'view',
  'column',
  'column.member',
  'viewColumn',
  'folder.tables',
  'folder.views',
  'folder.macros',
  'folder.columns',
  'folder.viewColumns',
  'folder.partitioning',
  'folder.sortOrder',
  'folder.statistics',
  'folder.history',
  'folder.tags',
  'folder.snapshots',
  'macro',
  'snapshot',
  'detail',
  'detail.table',
  'message',
];

/** One group of every match of `pattern` (group 0 is the whole match). */
const all = (text: string, pattern: RegExp, group = 1): string[] =>
  [...text.matchAll(pattern)].map((match) => match[group] ?? '');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The files are served from case-sensitive systems (code-server), so the letter case must match exactly. */
function exists(path: string): boolean {
  return !path.includes('\\') && existsExactCase(root, path);
}

/** The IHDR fields of a PNG file. */
function pngHeader(path: string): { width: number; height: number; bitDepth: number; colorType: number } {
  expect(exists(path), `${path} exists with exactly this letter case`).toBe(true);
  const file = readFileSync(join(root, path));
  expect(file.subarray(0, 8), `${path} is a PNG file`).toEqual(PNG_SIGNATURE);
  expect(file.toString('latin1', 12, 16), `${path} starts with an IHDR chunk`).toBe('IHDR');
  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
    bitDepth: file.readUInt8(24),
    colorType: file.readUInt8(25),
  };
}

const hiddenFromPalette = (menus['commandPalette'] ?? [])
  .filter(({ when }) => when === 'false')
  .map(({ command }) => command);

describe('the identity of the extension', () => {
  it('names the publisher, the author without an address and the licence, and can be published', () => {
    expect(manifest).toMatchObject({
      name: 'aantje',
      displayName: 'aantje',
      publisher: 'teitelberg',
      license: 'MIT',
      homepage: 'https://aantje.dev',
    });
    expect(manifest.author).toEqual({ name: 'Tillmann Eitelberg' });
    expect(manifest).not.toHaveProperty('private');
    const license = read('LICENSE');
    expect(license).toContain('MIT License');
    expect(license).toContain(`Copyright (c) 2026 ${manifest.author.name}`);
  });

  it('has a changelog entry for the version and no Unreleased section', () => {
    const heading = new RegExp(
      `^## \\[${manifest.version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`,
      'm',
    );
    expect(read('CHANGELOG.md')).toMatch(heading);
    expect(read('CHANGELOG.md')).not.toMatch(/unreleased/i);
  });

  it('points main at the file that esbuild writes', () => {
    const outfile = /\boutfile:\s*'([^']+)'/.exec(read('esbuild.mjs'))?.[1];
    expect(manifest.main).toBe(`./${outfile}`);
    expect(manifest.main).toBe('./dist/extension.js');
    const unbacked = (manifest.activationEvents ?? []).filter((event) => {
      const [kind, target = ''] = event.split(':');
      return !(
        (kind === 'onCommand' && commandIds.has(target)) ||
        (kind === 'onView' && viewIds.has(target))
      );
    });
    expect(unbacked).toEqual([]);
  });
});

describe('where the extension runs and what it may do', () => {
  it('runs next to the workspace, is off in virtual workspaces, and every setting has machine scope', () => {
    expect(manifest.extensionKind).toEqual(['workspace']);
    expect(manifest.capabilities).toMatchObject({
      virtualWorkspaces: { supported: false },
      untrustedWorkspaces: { supported: true },
    });
    // A workspace that could add a connection, point the S3 endpoint to its own server or choose where DuckDB loads
    // extensions from could attack the user, so Restricted Mode is safe only while every setting is machine scope.
    expect(settingIds.length).toBeGreaterThan(0);
    for (const id of settingIds) {
      expect(configuration.properties[id]?.scope, id).toBe('machine');
    }
  });

  it('is described the same way on the security page', () => {
    const declared = Object.fromEntries(
      Object.entries(manifest.capabilities).map(([name, { supported }]) => [name, supported]),
    );
    const documented = Object.fromEntries(
      [...read('docs/en/security.md').matchAll(/`capabilities\.(\w+)\.supported` is `(true|false)`/g)].map(
        (match) => [match[1] ?? '', match[2] === 'true'],
      ),
    );
    expect(documented).toEqual(declared);
  });
});

describe('the icons and pictures', () => {
  const pixels = async (path: string): Promise<{ data: Buffer; width: number; height: number }> => {
    const { data, info } = await sharp(join(root, path))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  };

  it('has a square extension icon of at least 128 px and Activity Bar icons that exist and draw something', () => {
    expect(manifest.icon).toBe('media/icon.png');
    const { width, height } = pngHeader(manifest.icon);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(128);
    expect(viewsContainers.activitybar).not.toHaveLength(0);
    for (const { id, icon } of viewsContainers.activitybar) {
      expect(exists(icon), `the icon of "${id}" (${icon}) exists with exactly this letter case`).toBe(true);
      if (!icon.endsWith('.svg')) {
        continue;
      }
      const svg = read(icon);
      const viewBox = /<svg\b[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1] ?? '';
      const [, , w, h] = viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      expect(w, `${icon} has a square viewBox`).toBe(h);
      const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map((match) => match[0]);
      expect(paths.length, `${icon} has a path`).toBeGreaterThan(0);
      for (const path of paths) {
        expect(/\sd="[^"]+"/.test(path), `${icon}: every path has a non-empty d`).toBe(true);
        expect(path, `${icon}: no path is left unfilled`).not.toMatch(/\sfill="none"/);
      }
    }
  });

  it('keeps logo.png transparent at the corners and media/icon.png the logo, pixel for pixel, on a square canvas', async () => {
    expect(pngHeader('media/logo.png')).toMatchObject({ width: 528, height: 570, bitDepth: 8, colorType: 6 });
    expect(pngHeader(manifest.icon)).toMatchObject({ width: 570, height: 570, bitDepth: 8, colorType: 6 });
    const logo = await pixels('media/logo.png');
    const icon = await pixels(manifest.icon);
    for (const [x, y] of [
      [0, 0],
      [logo.width - 1, 0],
      [0, logo.height - 1],
      [logo.width - 1, logo.height - 1],
    ] as const) {
      expect(logo.data[(y * logo.width + x) * 4 + 3], `the corner (${x}, ${y}) is transparent`).toBe(0);
    }
    const left = (icon.width - logo.width) / 2;
    let different = 0;
    let paddingAlpha = 0;
    for (let y = 0; y < icon.height; y++) {
      for (let x = 0; x < icon.width; x++) {
        const at = (y * icon.width + x) * 4;
        if (x < left || x >= left + logo.width) {
          paddingAlpha += icon.data[at + 3] ?? 0;
          continue;
        }
        const from = (y * logo.width + (x - left)) * 4;
        // Where the logo is transparent, the colour under the alpha is not part of the picture.
        const alpha = logo.data[from + 3];
        different +=
          alpha !== icon.data[at + 3] ||
          (alpha !== 0 && [0, 1, 2].some((c) => logo.data[from + c] !== icon.data[at + c]))
            ? 1
            : 0;
      }
    }
    expect(different, 'pixels that differ from the logo').toBe(0);
    expect(paddingAlpha, 'alpha of the padding left and right of the logo').toBe(0);
  });

  it('draws the Activity Bar glyph as one even-odd path without anything VS Code would ignore, covering the logo', async () => {
    const file = 'media/aantje-activity.svg';
    const svg = read(file);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    const rootTag = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
    expect(rootTag).toContain('viewBox="-21 0 570 570"');
    const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map((match) => match[0]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('fill-rule="evenodd"');
    // VS Code reads only the alpha channel; a picture, style sheet, clip path, mask or link is ignored or a leak.
    expect(svg).not.toMatch(
      /<(image|style|clipPath|mask|use|script|foreignObject)\b|\bhref=|xlink|data:|url\(/i,
    );

    const { data } = await sharp(Buffer.from(svg), { density: (72 * 570) / 24 })
      .ensureAlpha()
      .extractChannel('alpha')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const reference = await pixels(manifest.icon);
    expect(data).toHaveLength(reference.width * reference.height);
    let both = 0;
    let either = 0;
    for (let i = 0; i < data.length; i++) {
      const glyph = (data[i] ?? 0) > 127;
      const logo = (reference.data[i * 4 + 3] ?? 0) > 127;
      both += glyph && logo ? 1 : 0;
      either += glyph || logo ? 1 : 0;
    }
    // The glyph has slightly thicker lines than the logo; a blank, inverted or shifted picture lands far below.
    expect(both / either).toBeGreaterThan(0.8);
  });
});

describe('commands and menus', () => {
  it('names the maintenance scripts in the reports as the Maintenance menu does', () => {
    for (const [kind, label] of Object.entries(MAINTENANCE_LABEL)) {
      const command = `aantje.maintenance${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
      expect(commands.find((entry) => entry.command === command)?.title, command).toBe(label);
    }
  });

  it('declares every command once, in the category of the view container, and registers it in the code', () => {
    expect(commandIds.size).toBe(commands.length);
    const [container] = viewsContainers.activitybar;
    for (const { command, title, category } of commands) {
      expect(command).toMatch(/^aantje\.[a-z][A-Za-z0-9]+$/);
      expect(title, `${command} has a title`).toBeTruthy();
      expect(category, `${command} is in the category of the extension`).toBe(container?.title);
      expect(allSource, `${command} appears in the code`).toContain(`'${command}'`);
    }
  });

  it('uses only declared commands in menus, keyboard shortcuts and welcome texts, and gives toolbar commands an icon', () => {
    expect(menuEntries.length).toBeGreaterThan(0);
    expect(commandEntries.filter(({ command }) => !commandIds.has(command))).toEqual([]);
    const keybindings = manifest.contributes.keybindings ?? [];
    for (const { command, when } of keybindings) {
      expect(commandIds.has(command), command).toBe(true);
      // Without the context key the keys would take F5 and Ctrl+Enter from every other SQL extension.
      expect(when, command).toContain('aantje.queryEditor');
    }
    expect(viewsWelcome.filter(({ view }) => !viewIds.has(view))).toEqual([]);
    const linked = viewsWelcome.flatMap(({ contents }) => all(contents, /\(command:([\w.]+)/g));
    expect(linked).not.toHaveLength(0);
    expect(linked.filter((command) => !commandIds.has(command))).toEqual([]);
    const withIcon = new Set(commands.filter(({ icon }) => icon).map(({ command }) => command));
    const bare = commandEntries
      .filter(({ group }) => /^(navigation|inline)\b/.test(group ?? ''))
      .filter(({ command }) => !withIcon.has(command));
    expect(bare).toEqual([]);
  });

  it('keeps Create Azure DuckLake in the "..." menu of the explorer title, not as an icon', () => {
    // VS Code puts every view/title entry outside the group "navigation" into the "..." menu.
    const azure = commandEntries.filter(
      ({ menu, command }) => menu === 'view/title' && command === 'aantje.createAzureLake',
    );
    expect(azure).toHaveLength(1);
    expect(azure[0]?.group).not.toMatch(/^navigation\b/);
  });

  it('offers the same entries on the tables and views of an Azure DuckLake, except Create Notebook', () => {
    // Whether the viewItem condition of a rule holds for a context value; the other conditions are left aside.
    const offers = (when: string | undefined, item: string): boolean => {
      const pattern = /viewItem =~ \/(.+?)\/(?=\s|$)/.exec(when ?? '')?.[1];
      if (pattern !== undefined) return new RegExp(pattern).test(item);
      return /viewItem == ([\w.]+)/.exec(when ?? '')?.[1] === item;
    };
    const differing = menuEntries
      .filter(({ when }) => /viewItem (=~|==)/.test(when ?? ''))
      .flatMap(({ menu, when, command, submenu }) =>
        ['table', 'view']
          .filter((item) => offers(when, item) !== offers(when, `${item}.azure`))
          .map((item) => `${menu} ${command ?? submenu} ${item}`),
      );
    expect(differing).toEqual([
      'view/item/context aantje.createNotebook table',
      'view/item/context aantje.createNotebook view',
    ]);
  });

  it('keeps Allow My IP, Copy Azure Config and Delete Azure DuckLake in one section of the connection menu', () => {
    const groups = ['aantje.allowMyIp', 'aantje.copyAzureConfig', 'aantje.deleteAzureLake'].map(
      (id) =>
        commandEntries
          .find(({ menu, command }) => menu === 'view/item/context' && command === id)
          ?.group?.split('@')[0],
    );
    expect(groups[0]).toBeDefined();
    expect(new Set(groups).size).toBe(1);
  });

  it('keeps every command that is hidden from the Command Palette reachable from another menu', () => {
    const elsewhere = new Set(
      commandEntries.filter(({ menu }) => menu !== 'commandPalette').map(({ command }) => command),
    );
    expect(hiddenFromPalette.length).toBeGreaterThan(0);
    expect(hiddenFromPalette.filter((command) => !elsewhere.has(command ?? ''))).toEqual([]);
  });

  it('shows view menus only in a declared view, and knows every menu that it fills', () => {
    const lost = ['view/title', 'view/item/context'].flatMap((menu) =>
      (menus[menu] ?? [])
        .filter(({ when }) => !viewIds.has(/\bview == ([\w.]+)/.exec(when ?? '')?.[1] ?? ''))
        .map(({ command }) => `${menu}: ${command}`),
    );
    expect(lost).toEqual([]);
    const known = ['view/title', 'view/item/context', 'commandPalette', 'editor/title'];
    const declared = submenus.map(({ id }) => id);
    expect(Object.keys(menus).filter((menu) => !known.includes(menu) && !declared.includes(menu))).toEqual(
      [],
    );
    // Every submenu has entries and is opened from some menu.
    expect(declared.filter((id) => !(id in menus))).toEqual([]);
    expect(declared.filter((id) => !menuEntries.some(({ submenu }) => submenu === id))).toEqual([]);
  });

  it('keeps the script commands out of menus other than their submenu and the palette', () => {
    const outside = menuEntries
      .filter(({ command }) => command?.startsWith('aantje.script'))
      .filter(({ menu }) => !['aantje.script', 'commandPalette'].includes(menu));
    expect(outside).toEqual([]);
    for (const command of ['scriptSelect', 'scriptCreate', 'scriptAlter', 'scriptDrop']) {
      expect(hiddenFromPalette, command).toContain(`aantje.${command}`);
      expect(
        (menus['aantje.script'] ?? []).some((entry) => entry.command === `aantje.${command}`),
        command,
      ).toBe(true);
    }
  });
});

describe('the context values of the tree items', () => {
  it('are exactly the ones that the tree model sets', () => {
    const produced = new Set(all(read('src/tree/nodes.ts'), /contextValue: '([^']+)'/g));
    expect([...produced].sort()).toEqual([...CONTEXT_VALUES].sort());
  });

  it('are the only ones that the menu conditions ask for, and the context keys of the editor are set in the code', () => {
    const words = new Set(CONTEXT_VALUES.flatMap((value) => value.split('.')));
    const problems: string[] = [];
    let conditions = 0;
    for (const { menu, command, when = '' } of menuEntries) {
      const where = `${menu}: ${command}`;
      for (const value of all(when, /\bviewItem\s*[!=]=\s*([\w.]+)/g)) {
        conditions++;
        if (!CONTEXT_VALUES.includes(value)) {
          problems.push(`${where} compares viewItem with the unknown value "${value}"`);
        }
      }
      for (const source of all(when, /\bviewItem\s*[!=]~\s*\/((?:[^/\\]|\\.)*)\//g)) {
        conditions++;
        const unknown = all(source.replace(/\\./g, ' '), /[A-Za-z]+/g, 0).filter((word) => !words.has(word));
        if (unknown.length > 0) {
          problems.push(
            `${where} matches viewItem with /${source}/, which names unknown ${unknown.join(', ')}`,
          );
        } else if (!CONTEXT_VALUES.some((value) => new RegExp(source).test(value))) {
          problems.push(`${where} matches viewItem with /${source}/, which matches no context value`);
        }
      }
      for (const key of all(when, /\b(aantje\.query\w+)/g)) {
        conditions++;
        if (!allSource.includes(`'${key}'`)) {
          problems.push(`${where} asks for the context key ${key}, which no code sets`);
        }
      }
    }
    expect(conditions).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  const applies = (when: string, value: string): boolean =>
    all(when, /\bviewItem\s*==\s*([\w.]+)/g).every((expected) => expected === value) &&
    all(when, /\bviewItem\s*=~\s*\/((?:[^/\\]|\\.)*)\//g).every((source) => new RegExp(source).test(value));

  it('give an Azure DuckLake every entry of its state, and only it Allow My IP, Copy Azure Config and Delete Azure DuckLake', () => {
    const azureOnly = ['aantje.allowMyIp', 'aantje.copyAzureConfig', 'aantje.deleteAzureLake'];
    for (const state of ['connection.disconnected', 'connection.connected', 'connection.error']) {
      const shown = (value: string): string[] =>
        menuEntries
          .filter(({ menu }) => menu !== 'commandPalette')
          .filter(({ when = '' }) => /\bviewItem\b/.test(when) && applies(when, value))
          .map(({ menu, command, submenu }) => `${menu}: ${command ?? submenu}`);
      const plain = shown(state);
      const azure = shown(`${state}.azure`);
      expect(plain.length, state).toBeGreaterThan(0);
      expect(azure.filter((entry) => !plain.includes(entry)).toSorted(), state).toEqual(
        azureOnly.map((command) => `view/item/context: ${command}`),
      );
      expect(
        plain.filter((entry) => !azure.includes(entry)),
        state,
      ).toEqual([]);
    }
  });

  it('give the schema main every entry of a schema, with Script as DROP disabled there and nowhere else', () => {
    const shown = (value: string): string[] =>
      menuEntries
        .filter(({ menu }) => menu !== 'commandPalette')
        .filter(({ when = '' }) => /\bviewItem\b/.test(when) && applies(when, value))
        .map(({ menu, command, submenu }) => `${menu}: ${command ?? submenu}`);
    expect(shown('schema.main')).toEqual(shown('schema'));
    expect(shown('schema')).toContain('aantje.script: aantje.scriptDrop');

    // Every enablement is of the form `viewItem != value`: the command is disabled on that context value only.
    const disabled = commands.flatMap(({ command, enablement }) => {
      if (enablement === undefined) return [];
      const value = /^viewItem != ([\w.]+)$/.exec(enablement)?.[1];
      expect(value, `the enablement of ${command}`).toBeDefined();
      return [`${command} on ${value}`];
    });
    expect(disabled).toEqual(['aantje.scriptDrop on schema.main']);
  });

  it('offer no command on a detail or message node', () => {
    for (const value of ['detail', 'message']) {
      const offered = menuEntries
        .filter(({ menu }) => menu === 'view/item/context')
        .filter(({ when = '' }) => applies(when, value))
        .map(({ command }) => command);
      expect(offered, value).toEqual([]);
    }
  });
});

describe('views and settings', () => {
  it('puts every view into a declared container', () => {
    const containerIds = new Set(viewsContainers.activitybar.map(({ id }) => id));
    expect(Object.keys(views)).not.toHaveLength(0);
    expect(Object.keys(views).filter((container) => !containerIds.has(container))).toEqual([]);
  });

  it('declares exactly the settings that the code reads, and the limits that the code clamps to', () => {
    expect(settingIds.length).toBeGreaterThan(0);
    for (const id of settingIds) {
      expect(allSource, `${id} is read in the code`).toContain(`'${id.replace('aantje.', '')}'`);
    }
    const keys = [
      ...all(allSource, /getConfiguration\('aantje'\)\s*\.get<unknown>\('([\w.]+)'\)/g),
      ...all(read('src/data/settings.ts'), /\btext\('([\w.]+)'\)/g),
    ];
    expect(keys.map((key) => `aantje.${key}`).filter((id) => !settingIds.includes(id))).toEqual([]);
    expect(configuration.properties['aantje.queryTimeoutSeconds']?.maximum).toBe(MAX_TIMEOUT_SECONDS);
    expect(configuration.properties['aantje.sql.maxRows']).toMatchObject({
      type: 'integer',
      default: 10_000,
      minimum: 1,
      maximum: 1_000_000,
    });
  });
});

describe('README.md', () => {
  const readme = read('README.md');

  it('lists every setting and profile property in a table, documents none that does not exist, and states the defaults', () => {
    const rows = readme
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    const documented = rows.flatMap(([first = '']) => all(first, /`([^`]+)`/g));
    const declared = [...settingIds, ...Object.keys(profileProperties)];
    expect(declared.filter((name) => !documented.includes(name))).toEqual([]);
    expect(documented.filter((name) => !declared.includes(name))).toEqual([]);

    const rowOf = (name: string): string[] => {
      const found = rows.filter(([first = '']) => all(first, /`([^`]+)`/g).includes(name));
      expect(found, `exactly one row names ${name}`).toHaveLength(1);
      return found[0] ?? [];
    };
    const shown = (value: unknown): string => `\`${JSON.stringify(value)}\``;
    for (const id of ['aantje.connections', 'aantje.queryTimeoutSeconds', 'aantje.sql.maxRows']) {
      expect(rowOf(id)[1], id).toBe(shown(configuration.properties[id]?.default));
    }
    // The port as a whole number: 15432 does not state the default 5432.
    expect(rowOf('port')[2]).toMatch(
      new RegExp(`(?<![0-9])${String(profileProperties['port']?.default)}(?![0-9])`),
    );
    expect(all(rowOf('kind')[2] ?? '', /`([^`]+)`/g)).toEqual(profileProperties['kind']?.enum);
    // TLS is on unless the host is the local machine: a default of false in the schema would tell the editor the reverse.
    expect(profileProperties['ssl']).not.toHaveProperty('default');
  });

  it('mentions only settings, commands and views that exist, and shows an example that the profile parser accepts', () => {
    const known = new Set([...settingIds, ...commandIds, ...viewIds]);
    const mentioned = all(readme, /\baantje(?:\.[A-Za-z][A-Za-z0-9]*)+/g, 0);
    expect(mentioned).not.toHaveLength(0);
    const site = new URL(manifest.homepage).host;
    expect(mentioned.filter((name) => name !== site && !known.has(name))).toEqual([]);

    const json = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
    const example = JSON.parse(json ?? '') as Record<string, unknown>;
    const { profiles, problems } = parseProfiles(example['aantje.connections']);
    expect(problems).toEqual([]);
    expect(profiles.map(({ kind }) => kind)).toEqual(['postgres', 'sqlite']);
  });

  it('claims the VS Code version and the specification version that the code needs, and no telemetry', () => {
    const named = /VS Code (\d+\.\d+)/.exec(readme)?.[1];
    expect(`^${named}.0`).toBe(manifest.engines.vscode);
    const accepted = /SUPPORTED_VERSION = \/\^(\d+)/.exec(read('src/catalog/reader/core.ts'))?.[1];
    expect(/specification (\d+)\.x/.exec(readme)?.[1]).toBe(accepted);
    expect(readme).toContain('**No telemetry.**');
    expect(sources.filter(({ text }) => /telemetry/i.test(text))).toEqual([]);
    expect(Object.keys(manifest).filter((key) => /telemetry/i.test(key))).toEqual([]);
  });

  it('shows the logo and the screenshots, and every image exists', () => {
    const images = [...all(readme, /!\[[^\]]*\]\(([^)\s]+)/g), ...all(readme, /<img\b[^>]*\ssrc="([^"]+)"/g)];
    expect(images.sort()).toEqual([
      'media/logo.png',
      'media/workbench-growth.png',
      'media/workbench-macro.png',
      'media/workbench-select.png',
      'media/workbench-table-statistics.png',
    ]);
    for (const image of images) {
      expect(exists(image), image).toBe(true);
    }
  });
});

describe('the module map of the architecture page', () => {
  // A file is on the map when the page names it, when a `folder/*` entry covers its folder, or when it is in the
  // list of the files of the report folders.
  it('names every file under src/', () => {
    const text = read('docs/en/architecture.md');
    const map = text.slice(text.indexOf('## Module map'));
    const reportFiles = new Set<string>();
    for (const line of map.split('\n')) {
      const listed = /^([\w-]+\/)\s+(.+)$/.exec(line);
      for (const name of listed ? (listed[2] ?? '').split(/\s+/) : [])
        reportFiles.add(`src/${listed?.[1]}${name}.ts`);
    }
    const existing = sources.map(({ file }) => file);
    expect(existing).not.toHaveLength(0);
    const unnamed = existing.filter((file) => {
      const parts = file.split('/');
      const folder = parts.at(-2) ?? '';
      return (
        !map.includes(`\`${parts.at(-1)}\``) &&
        !map.includes(`${folder}/*`) &&
        !reportFiles.has(file) &&
        !map.includes(`${folder}/${parts.at(-1)}`)
      );
    });
    expect(unnamed).toEqual([]);
  });
});
