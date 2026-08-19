/**
 * Dhylapse schema barrel.
 *
 * Import order mirrors dependency order:
 *   tenancy -> catalog -> inventory -> alerts -> workflows -> platform
 *
 * See docs/SCHEMA.md for the design rationale and the complaint-driven
 * decisions behind each table.
 */

export * from './_shared.ts';
export * from './tenancy.ts';
export * from './auth.ts';
export * from './catalog.ts';
export * from './inventory.ts';
export * from './alerts.ts';
export * from './workflows.ts';
export * from './platform.ts';
