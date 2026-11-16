import dotenv from 'dotenv';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initializeDatabase() {
  const schemaUrl = new URL('./schema.sql', import.meta.url);
  const schema = await readFile(fileURLToPath(schemaUrl), 'utf8');
  await pool.query(schema);
}

export async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
