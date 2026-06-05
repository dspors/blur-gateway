import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

function sqlString(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export class Sqlite {
  constructor(public readonly dbPath: string = config.dbPath) {}

  init(): void {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.exec(`
      create table if not exists files (
        id text primary key,
        filename text not null,
        purpose text,
        bytes integer not null,
        content_type text,
        path text not null,
        created_at text not null
      );

      create table if not exists chains (
        id text primary key,
        provider text not null,
        model text not null,
        title text not null,
        workspace_dir text not null,
        provider_session_id text,
        provider_session_title text,
        archived integer not null default 0,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists responses (
        id text primary key,
        chain_id text not null,
        previous_response_id text,
        status text not null,
        input_json text not null,
        output_text text,
        error text,
        created_at text not null,
        updated_at text not null,
        foreign key(chain_id) references chains(id)
      );

      create table if not exists response_files (
        response_id text not null,
        file_id text not null,
        workspace_path text not null,
        primary key(response_id, file_id)
      );
    `);
  }

  exec(sql: string): void {
    execFileSync('sqlite3', [this.dbPath], { input: sql, encoding: 'utf8' });
  }

  json<T = Record<string, unknown>>(sql: string): T[] {
    const out = execFileSync('sqlite3', ['-readonly', '-json', this.dbPath, sql], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    return out ? JSON.parse(out) as T[] : [];
  }

  insertFile(file: { id: string; filename: string; purpose?: string; bytes: number; contentType?: string; path: string; createdAt: string }): void {
    this.exec(`insert into files (id, filename, purpose, bytes, content_type, path, created_at)
      values (${sqlString(file.id)}, ${sqlString(file.filename)}, ${sqlString(file.purpose)}, ${file.bytes},
              ${sqlString(file.contentType)}, ${sqlString(file.path)}, ${sqlString(file.createdAt)});`);
  }

  getFile(fileId: string): any | null {
    return this.json(`select * from files where id = ${sqlString(fileId)} limit 1`)[0] || null;
  }

  insertChain(chain: any): void {
    this.exec(`insert into chains (id, provider, model, title, workspace_dir, provider_session_id, provider_session_title, archived, created_at, updated_at)
      values (${sqlString(chain.id)}, ${sqlString(chain.provider)}, ${sqlString(chain.model)}, ${sqlString(chain.title)},
              ${sqlString(chain.workspaceDir)}, ${sqlString(chain.providerSessionId)}, ${sqlString(chain.providerSessionTitle)},
              ${chain.archived ? 1 : 0}, ${sqlString(chain.createdAt)}, ${sqlString(chain.updatedAt)});`);
  }

  updateChainSession(chainId: string, providerSessionId: string | null, providerSessionTitle: string | null): void {
    this.exec(`update chains set provider_session_id = ${sqlString(providerSessionId)}, provider_session_title = ${sqlString(providerSessionTitle)}, updated_at = ${sqlString(new Date().toISOString())} where id = ${sqlString(chainId)};`);
  }

  archiveChain(chainId: string): void {
    this.exec(`update chains set archived = 1, updated_at = ${sqlString(new Date().toISOString())} where id = ${sqlString(chainId)};`);
  }

  getChain(chainId: string): any | null {
    return this.json(`select * from chains where id = ${sqlString(chainId)} limit 1`)[0] || null;
  }

  listChains(): any[] {
    return this.json('select * from chains order by updated_at desc limit 200');
  }

  insertResponse(response: any): void {
    this.exec(`insert into responses (id, chain_id, previous_response_id, status, input_json, output_text, error, created_at, updated_at)
      values (${sqlString(response.id)}, ${sqlString(response.chainId)}, ${sqlString(response.previousResponseId)},
              ${sqlString(response.status)}, ${sqlString(JSON.stringify(response.input))}, ${sqlString(response.outputText)},
              ${sqlString(response.error)}, ${sqlString(response.createdAt)}, ${sqlString(response.updatedAt)});`);
  }

  updateResponse(responseId: string, fields: { status?: string; outputText?: string | null; error?: string | null }): void {
    const sets = [`updated_at = ${sqlString(new Date().toISOString())}`];
    if (fields.status !== undefined) sets.push(`status = ${sqlString(fields.status)}`);
    if (fields.outputText !== undefined) sets.push(`output_text = ${sqlString(fields.outputText)}`);
    if (fields.error !== undefined) sets.push(`error = ${sqlString(fields.error)}`);
    this.exec(`update responses set ${sets.join(', ')} where id = ${sqlString(responseId)};`);
  }

  getResponse(responseId: string): any | null {
    return this.json(`select r.*, c.provider, c.model, c.title, c.workspace_dir, c.provider_session_id, c.provider_session_title, c.archived
      from responses r join chains c on c.id = r.chain_id where r.id = ${sqlString(responseId)} limit 1`)[0] || null;
  }

  linkResponseFile(responseId: string, fileId: string, workspacePath: string): void {
    this.exec(`insert or replace into response_files (response_id, file_id, workspace_path)
      values (${sqlString(responseId)}, ${sqlString(fileId)}, ${sqlString(workspacePath)});`);
  }
}

export const db = new Sqlite();
