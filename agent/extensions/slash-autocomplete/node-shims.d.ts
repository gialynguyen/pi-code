// Minimal ambient declarations for the node:fs / node:path built-ins used by this
// extension, so `tsc --noEmit` typechecks without @types/node in the extension's
// own node_modules. pi provides these at runtime via Node.js.
declare module "node:fs" {
	export function readFileSync(path: string, encoding: string): string;
	export function writeFileSync(path: string, data: string, encoding: string): void;
	export function mkdirSync(path: string, options: { recursive: boolean }): string | undefined;
}
declare module "node:path" {
	export function join(...paths: string[]): string;
	export function dirname(path: string): string;
}