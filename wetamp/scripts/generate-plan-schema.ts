import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requirementsSchema, requestRefSchema } from '../src/plan';
import { WETAMP } from '../src/config';

const path = join(WETAMP, 'schemas/plan.schema.json');
const bytes = readFileSync(path, 'utf8');
const schema = JSON.parse(bytes);
const property = '          "requirements": { "$ref": "#/$defs/requirements" },\n';
let updated = schema.properties.packages.items.properties.requirements
  ? bytes
  : bytes.replace('          "accept": {', property + '          "accept": {');
const definition = `    "requirements": ${JSON.stringify(requirementsSchema)},`;
updated = schema.$defs.requirements
  ? updated.replace(/^ {4}"requirements": [\s\S]*?(?=^ {4}"check":)/m, definition + '\n')
  : updated.replace('  "$defs": {', '  "$defs": {\n' + definition);
// Derive the additive field from its owner without reformatting the existing mirror.
updated = updated.replace(/^    "request_ref": .*\n/m, '');
updated = updated.replace(
  '  "properties": {',
  '  "properties": {\n    "request_ref": ' + JSON.stringify(requestRefSchema) + ','
);
writeFileSync(path, updated);
