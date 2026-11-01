// Saved report templates (Phase 8b Step D): one JSON file for all sites, written atomically (temp file + rename).
// The only thing the app writes to disk. No auth: anyone on the network can edit, so updates can carry the
// updatedAt they started from and get 409 if someone else saved in between.
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { isBuiltinId, STARTER_TEMPLATES } from './custom/presets.js';
import { TemplateBodySchema, type Template, type TemplateBody } from './custom/template.js';

/** Saved templates per site (bounds the file; built-ins do not count). */
export const MAX_TEMPLATES_PER_SITE = 200;
// v2 keeps the default as a per-site pointer (it may name a built-in); v1 had an isDefault flag on each template.
const FILE_VERSION = 2;

export class TemplateNotFoundError extends Error {
  override readonly name = 'TemplateNotFoundError';
  readonly statusCode = 404;
  constructor() {
    super('Template not found. It may have been deleted; reload the template list.');
  }
}

/** Name taken, too many templates, or changed by someone else since it was loaded. */
export class TemplateConflictError extends Error {
  override readonly name = 'TemplateConflictError';
  readonly statusCode = 409;
}

export class ReadOnlyTemplateError extends Error {
  override readonly name = 'ReadOnlyTemplateError';
  readonly statusCode = 403;
  constructor() {
    super('Built-in templates are read-only. Use "Save as" to make an editable copy.');
  }
}

export interface TemplateStore {
  /** The site's saved templates, by name (case-insensitive). */
  list(site: string): Promise<Template[]>;
  get(id: string): Promise<Template>;
  create(site: string, body: TemplateBody): Promise<Template>;
  /** Replaces name, defaults and sheets. `expectedUpdatedAt` (if given) must match the stored one, else 409. */
  update(id: string, body: TemplateBody, expectedUpdatedAt?: string): Promise<Template>;
  delete(id: string): Promise<void>;
  /**
   * Points the site's default at `id` (a saved template, or a built-in on `site`). A saved template's own site wins
   * over `site`. Returns the site and id.
   */
  setDefault(id: string, site?: string): Promise<DefaultPointer>;
  /** Unsets the site's default if it is `id` (no-op otherwise). Same site rule as setDefault. */
  clearDefault(id: string, site?: string): Promise<DefaultPointer>;
  /** The site's default (a saved template id or a built-in id), if it names one that exists. */
  defaultId(site: string): Promise<string | undefined>;
  /** Browser choices kept in the same file (List columns, favourites): localStorage key → value. */
  settings(): Promise<Record<string, string>>;
  setSetting(key: string, value: string): Promise<void>;
}

export interface DefaultPointer {
  site: string;
  id: string;
}

/** A template as stored: isDefault is not kept on the template (see the file's `defaults`). */
type StoredTemplate = Omit<Template, 'isDefault'>;

const StoredTemplateSchema = TemplateBodySchema.extend({
  id: z.string().min(1).max(100),
  site: z.string().min(1).max(100),
  // v1 only (read once to migrate to `defaults`).
  isDefault: z.boolean().optional(),
  updatedAt: z.string().min(1),
});

const FileSchema = z.union([
  z.object({ version: z.literal(1), templates: z.array(z.unknown()) }),
  z.object({
    version: z.literal(FILE_VERSION),
    // Site key → default template id (saved or builtin:*).
    defaults: z.record(z.string(), z.string()).default({}),
    // localStorage key → value (List columns, favourites); see routes/settings.ts.
    settings: z.record(z.string(), z.string()).default({}),
    templates: z.array(z.unknown()),
  }),
]);

/** File operations the store needs (injectable for tests). */
export interface StoreFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
}

interface Loaded {
  templates: StoredTemplate[];
  /** Entries that no longer validate: not listed, but written back unchanged so nothing is lost. */
  invalid: unknown[];
  /** Site key → default id. May name a template that no longer exists (hand edit); defaultOf() checks. */
  defaults: Record<string, string>;
  /** Browser choices (localStorage key → value), written back unchanged by template saves. */
  settings: Record<string, string>;
}

const isStarterId = (id: string) => STARTER_TEMPLATES.some((s) => s.id === id);

/** The site's default id, if it names a built-in or a valid saved template of that site. */
function defaultOf(data: Loaded, site: string): string | undefined {
  const id = data.defaults[site];
  if (id === undefined) return undefined;
  return isStarterId(id) || data.templates.some((t) => t.id === id && t.site === site) ? id : undefined;
}

const withDefault = (data: Loaded, t: StoredTemplate): Template => ({ ...t, isDefault: data.defaults[t.site] === t.id });

const byName = (a: StoredTemplate, b: StoredTemplate) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Validation rules for a site's set of templates: names unique per site (case-insensitive), not a built-in's name,
 * at most MAX_TEMPLATES_PER_SITE. Throws TemplateConflictError.
 */
export function checkName(existing: readonly StoredTemplate[], site: string, name: string, exceptId?: string): void {
  if (STARTER_TEMPLATES.some((s) => sameName(s.name, name))) {
    throw new TemplateConflictError(`"${name}" is the name of a built-in template. Pick another name.`);
  }
  if (existing.some((t) => t.site === site && t.id !== exceptId && sameName(t.name, name))) {
    throw new TemplateConflictError(`A template named "${name}" already exists on this site. Pick another name.`);
  }
}

/** JSON file store. Every operation runs in one in-process queue, so read-modify-write cannot interleave. */
export class FileTemplateStore implements TemplateStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly opts: {
      fs?: StoreFs;
      now?: () => Date;
      newId?: () => string;
      /** Corrupt file moved aside, invalid entries skipped. */
      onWarn?: (message: string) => void;
    } = {},
  ) {}

  private get fs(): StoreFs {
    return this.opts.fs ?? (nodeFs as unknown as StoreFs);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  list(site: string): Promise<Template[]> {
    return this.exclusive(async () => {
      const data = await this.load();
      return data.templates.filter((t) => t.site === site).sort(byName).map((t) => withDefault(data, t));
    });
  }

  get(id: string): Promise<Template> {
    return this.exclusive(async () => {
      const data = await this.load();
      return withDefault(data, find(data, id, false));
    });
  }

  defaultId(site: string): Promise<string | undefined> {
    return this.exclusive(async () => defaultOf(await this.load(), site));
  }

  settings(): Promise<Record<string, string>> {
    return this.exclusive(async () => ({ ...(await this.load()).settings }));
  }

  setSetting(key: string, value: string): Promise<void> {
    return this.exclusive(async () => {
      const data = await this.load();
      data.settings[key] = value;
      await this.save(data);
    });
  }

  create(site: string, body: TemplateBody): Promise<Template> {
    return this.exclusive(async () => {
      const data = await this.load();
      checkName(data.templates, site, body.name);
      if (data.templates.filter((t) => t.site === site).length >= MAX_TEMPLATES_PER_SITE) {
        throw new TemplateConflictError(`At most ${MAX_TEMPLATES_PER_SITE} templates per site. Delete one first.`);
      }
      const template: StoredTemplate = { id: this.opts.newId?.() ?? randomUUID(), site, updatedAt: this.stamp(), ...body };
      data.templates.push(template);
      await this.save(data);
      return { ...template, isDefault: false };
    });
  }

  update(id: string, body: TemplateBody, expectedUpdatedAt?: string): Promise<Template> {
    return this.exclusive(async () => {
      const data = await this.load();
      const old = find(data, id);
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== old.updatedAt) {
        throw new TemplateConflictError(`"${old.name}" was changed by someone else since you loaded it. Reload it, or use "Save as".`);
      }
      checkName(data.templates, old.site, body.name, id);
      const template: StoredTemplate = { id, site: old.site, updatedAt: this.stamp(old.updatedAt), ...body };
      data.templates = data.templates.map((t) => (t.id === id ? template : t));
      await this.save(data);
      return withDefault(data, template);
    });
  }

  delete(id: string): Promise<void> {
    return this.exclusive(async () => {
      const data = await this.load();
      const old = find(data, id);
      data.templates = data.templates.filter((t) => t.id !== id);
      // Deleting the default leaves the site with none.
      if (data.defaults[old.site] === id) delete data.defaults[old.site];
      await this.save(data);
    });
  }

  setDefault(id: string, site?: string): Promise<DefaultPointer> {
    return this.exclusive(async () => {
      const data = await this.load();
      const pointer = target(data, id, site);
      // Only the pointer changes: no template's updatedAt (the edit-conflict token) moves.
      data.defaults[pointer.site] = id;
      await this.save(data);
      return pointer;
    });
  }

  clearDefault(id: string, site?: string): Promise<DefaultPointer> {
    return this.exclusive(async () => {
      const data = await this.load();
      const pointer = target(data, id, site);
      if (data.defaults[pointer.site] === id) {
        delete data.defaults[pointer.site];
        await this.save(data);
      }
      return pointer;
    });
  }

  /** ISO timestamp, strictly later than `previous` (so two quick saves still differ as conflict tokens). */
  private stamp(previous?: string): string {
    let ms = (this.opts.now?.() ?? new Date()).getTime();
    if (previous && Date.parse(previous) >= ms) ms = Date.parse(previous) + 1;
    return new Date(ms).toISOString();
  }

  /** Missing file = no templates. A corrupt file is moved aside (`<file>.corrupt-<time>`) and the store starts empty. */
  private async load(): Promise<Loaded> {
    let text: string;
    try {
      text = await this.fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { templates: [], invalid: [], defaults: {}, settings: {} };
      throw err;
    }
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(text.replace(/^﻿/, '')));
    } catch {
      const aside = `${this.file}.corrupt-${(this.opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')}`;
      await this.fs.rename(this.file, aside);
      this.opts.onWarn?.(`Template file ${basename(this.file)} was not valid JSON for this app; moved to ${basename(aside)}. Starting with no saved templates.`);
      return { templates: [], invalid: [], defaults: {}, settings: {} };
    }
    const out: Loaded = {
      templates: [],
      invalid: [],
      defaults: parsed.version === 1 ? {} : { ...parsed.defaults },
      settings: parsed.version === 1 ? {} : { ...parsed.settings },
    };
    const ids = new Set<string>();
    for (const entry of parsed.templates) {
      const t = StoredTemplateSchema.safeParse(entry);
      if (t.success && !ids.has(t.data.id) && !isBuiltinId(t.data.id)) {
        const { isDefault, ...template } = t.data;
        ids.add(template.id);
        out.templates.push(template);
        // v1 → v2: the (first) flagged template of a site becomes its default pointer.
        if (parsed.version === 1 && isDefault && out.defaults[template.site] === undefined) out.defaults[template.site] = template.id;
      } else {
        out.invalid.push(entry);
      }
    }
    if (out.invalid.length) this.opts.onWarn?.(`Template file: ${out.invalid.length} invalid entr${out.invalid.length === 1 ? 'y' : 'ies'} skipped (kept in the file).`);
    return out;
  }

  /** Atomic: write a temp file next to the target, then rename it over the target. */
  private async save(data: Loaded): Promise<void> {
    const { fs } = this;
    await fs.mkdir(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.${basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
    const json = `${JSON.stringify({ version: FILE_VERSION, defaults: data.defaults, settings: data.settings, templates: [...data.templates, ...data.invalid] }, null, 2)}\n`;
    try {
      await fs.writeFile(tmp, json, 'utf8');
      await renameWithRetry(fs, tmp, this.file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

/** The saved template `id`. Changing a built-in is 403 (the store never holds them). */
function find(data: Loaded, id: string, forChange = true): StoredTemplate {
  if (forChange && isBuiltinId(id)) throw new ReadOnlyTemplateError();
  const t = data.templates.find((x) => x.id === id);
  if (!t) throw new TemplateNotFoundError();
  return t;
}

/** Site + id a default pointer is about: a saved template's own site, or a built-in on `site` (404 if neither). */
function target(data: Loaded, id: string, site: string | undefined): DefaultPointer {
  if (isBuiltinId(id)) {
    if (!isStarterId(id) || site === undefined) throw new TemplateNotFoundError();
    return { site, id };
  }
  return { site: find(data, id).site, id };
}

/** Windows: a rename over a file another process (antivirus, indexer) has open briefly fails with EPERM/EACCES/EBUSY. */
async function renameWithRetry(fs: StoreFs, from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw err;
      await new Promise((r) => setTimeout(r, 20 * i));
    }
  }
}
