import fs from 'node:fs';
import path from 'node:path';
import { openSqlite, type DatabaseT } from 'blur-db';
import { config } from '../config';

function sqlString(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export class Sqlite {
  private readonly db: DatabaseT;

  constructor(public readonly dbPath: string = config.dbPath) {
    this.db = openSqlite({ dbPath });
  }

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
        last_input_text text,
        last_input_len integer,
        last_input_hash text,
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

      create table if not exists request_log (
        id text primary key,
        timestamp text not null,
        method text not null,
        path text not null,
        status_code integer not null,
        duration_ms integer not null,
        remote_addr text,
        user_agent text,
        host text,
        x_forwarded_for text,
        x_request_id text,
        authorization_present integer not null default 0,
        content_length integer,
        response_id text,
        provider text,
        error text
      );

      create table if not exists response_metrics (
        id text primary key,
        response_id text not null,
        provider text not null,
        started_at text not null,
        completed_at text,
        is_new_session integer not null,
        had_previous_response_id integer not null,
        input_chars integer not null,
        injected_chars integer not null,
        delta_stripped integer not null default 0,
        file_count integer not null default 0,
        automation_status text not null,
        automation_duration_ms integer,
        readback_duration_ms integer,
        final_status text,
        error text
      );

      create index if not exists idx_request_log_timestamp on request_log(timestamp);
      create index if not exists idx_response_metrics_started on response_metrics(started_at);
      create index if not exists idx_response_metrics_response on response_metrics(response_id);
    `);
    this.ensureColumn('chains', 'last_input_text', 'text');
    this.ensureColumn('chains', 'last_input_len', 'integer');
    this.ensureColumn('chains', 'last_input_hash', 'text');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  json<T = Record<string, unknown>>(sql: string): T[] {
    return this.db.prepare(sql).all() as T[];
  }

  ensureColumn(table: string, column: string, type: string): void {
    const columns = this.json<{ name: string }>(`pragma table_info(${table})`).map(row => row.name);
    if (!columns.includes(column)) this.exec(`alter table ${table} add column ${column} ${type};`);
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

  updateChainInputState(chainId: string, state: { text: string; len: number; hash: string }): void {
    this.exec(`update chains set last_input_text = ${sqlString(state.text)}, last_input_len = ${Number(state.len)}, last_input_hash = ${sqlString(state.hash)}, updated_at = ${sqlString(new Date().toISOString())} where id = ${sqlString(chainId)};`);
  }

  archiveChain(chainId: string): void {
    this.exec(`update chains set archived = 1, updated_at = ${sqlString(new Date().toISOString())} where id = ${sqlString(chainId)};`);
  }

  unarchiveChain(chainId: string): void {
    this.exec(`update chains set archived = 0, updated_at = ${sqlString(new Date().toISOString())} where id = ${sqlString(chainId)};`);
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

  upsertResponse(response: any): void {
    this.exec(`insert into responses (id, chain_id, previous_response_id, status, input_json, output_text, error, created_at, updated_at)
      values (${sqlString(response.id)}, ${sqlString(response.chainId)}, ${sqlString(response.previousResponseId)},
              ${sqlString(response.status)}, ${sqlString(JSON.stringify(response.input))}, ${sqlString(response.outputText)},
              ${sqlString(response.error)}, ${sqlString(response.createdAt)}, ${sqlString(response.updatedAt)})
      on conflict(id) do update set
        previous_response_id = excluded.previous_response_id,
        status = excluded.status,
        input_json = excluded.input_json,
        output_text = excluded.output_text,
        error = excluded.error,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at;`);
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

  insertRequestLog(row: any): void {
    this.exec(`insert into request_log
      (id, timestamp, method, path, status_code, duration_ms, remote_addr, user_agent, host, x_forwarded_for,
       x_request_id, authorization_present, content_length, response_id, provider, error)
      values (${sqlString(row.id)}, ${sqlString(row.timestamp)}, ${sqlString(row.method)}, ${sqlString(row.path)},
              ${Number(row.statusCode || 0)}, ${Number(row.durationMs || 0)}, ${sqlString(row.remoteAddr)},
              ${sqlString(row.userAgent)}, ${sqlString(row.host)}, ${sqlString(row.xForwardedFor)},
              ${sqlString(row.xRequestId)}, ${row.authorizationPresent ? 1 : 0},
              ${row.contentLength === undefined || row.contentLength === null ? 'null' : Number(row.contentLength)},
              ${sqlString(row.responseId)}, ${sqlString(row.provider)}, ${sqlString(row.error)});`);
  }

  listRequestLog(limit = 100): any[] {
    const bounded = Math.max(1, Math.min(limit, 1000));
    return this.json(`select * from request_log order by timestamp desc limit ${bounded}`);
  }

  insertResponseMetric(row: any): void {
    this.exec(`insert into response_metrics
      (id, response_id, provider, started_at, completed_at, is_new_session, had_previous_response_id,
       input_chars, injected_chars, delta_stripped, file_count, automation_status, automation_duration_ms,
       readback_duration_ms, final_status, error)
      values (${sqlString(row.id)}, ${sqlString(row.responseId)}, ${sqlString(row.provider)}, ${sqlString(row.startedAt)},
              ${sqlString(row.completedAt)}, ${row.isNewSession ? 1 : 0}, ${row.hadPreviousResponseId ? 1 : 0},
              ${Number(row.inputChars || 0)}, ${Number(row.injectedChars || 0)}, ${row.deltaStripped ? 1 : 0},
              ${Number(row.fileCount || 0)}, ${sqlString(row.automationStatus || 'started')},
              ${row.automationDurationMs === undefined || row.automationDurationMs === null ? 'null' : Number(row.automationDurationMs)},
              ${row.readbackDurationMs === undefined || row.readbackDurationMs === null ? 'null' : Number(row.readbackDurationMs)},
              ${sqlString(row.finalStatus)}, ${sqlString(row.error)});`);
  }

  updateResponseMetric(metricId: string, fields: any): void {
    const sets = [];
    if (fields.completedAt !== undefined) sets.push(`completed_at = ${sqlString(fields.completedAt)}`);
    if (fields.automationStatus !== undefined) sets.push(`automation_status = ${sqlString(fields.automationStatus)}`);
    if (fields.automationDurationMs !== undefined) sets.push(`automation_duration_ms = ${Number(fields.automationDurationMs)}`);
    if (fields.readbackDurationMs !== undefined) sets.push(`readback_duration_ms = ${Number(fields.readbackDurationMs)}`);
    if (fields.finalStatus !== undefined) sets.push(`final_status = ${sqlString(fields.finalStatus)}`);
    if (fields.error !== undefined) sets.push(`error = ${sqlString(fields.error)}`);
    if (!sets.length) return;
    this.exec(`update response_metrics set ${sets.join(', ')} where id = ${sqlString(metricId)};`);
  }

  listResponseMetrics(limit = 100): any[] {
    const bounded = Math.max(1, Math.min(limit, 1000));
    return this.json(`select * from response_metrics order by started_at desc limit ${bounded}`);
  }

  hourlyRequestRollup(hours = 24): any[] {
    const bounded = Math.max(1, Math.min(hours, 168));
    return this.json(`
      select substr(timestamp, 1, 13) || ':00:00Z' as hour,
             path,
             count(*) as count,
             sum(case when status_code >= 400 then 1 else 0 end) as error_count,
             min(duration_ms) as min_ms,
             round(avg(duration_ms), 2) as avg_ms,
             max(duration_ms) as max_ms
      from request_log
      where timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${bounded} hours')
      group by hour, path
      order by hour desc, path asc
    `);
  }

  hourlyResponseRollup(hours = 24): any[] {
    const bounded = Math.max(1, Math.min(hours, 168));
    return this.json(`
      select substr(started_at, 1, 13) || ':00:00Z' as hour,
             provider,
             count(*) as count,
             sum(case when error is not null then 1 else 0 end) as error_count,
             sum(is_new_session) as new_sessions,
             sum(had_previous_response_id) as followups,
             sum(delta_stripped) as delta_strip_count,
             round(avg(input_chars), 2) as avg_input_chars,
             round(avg(injected_chars), 2) as avg_injected_chars,
             min(automation_duration_ms) as min_automation_ms,
             round(avg(automation_duration_ms), 2) as avg_automation_ms,
             max(automation_duration_ms) as max_automation_ms
      from response_metrics
      where started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${bounded} hours')
      group by hour, provider
      order by hour desc, provider asc
    `);
  }
}

export const db = new Sqlite();
