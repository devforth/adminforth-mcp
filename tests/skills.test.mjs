import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FETCH_SKILL_TOOL_NAME, McpSkills } from '../dist/skills.js';
import { createMcpServerPresentation } from '../dist/mcpProtocol.js';

const PLUGIN_CUSTOM_FOLDER = fileURLToPath(new URL('../custom', import.meta.url));
const PLUGIN_VALUES = { 'pageSize.default': 10, 'pageSize.max': 100, toolCallsPerRequest: 10 };
// Claude Code truncates MCP server instructions after this many characters.
const CLIENT_INSTRUCTIONS_LIMIT = 2048;

function createCustomFolder({ instructions, skills }) {
  const folder = mkdtempSync(join(tmpdir(), 'adminforth-mcp-skills-'));
  if (instructions !== undefined) writeFileSync(join(folder, 'instructions.md'), instructions);
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(join(folder, 'skills', name), { recursive: true });
    writeFileSync(join(folder, 'skills', name, 'SKILL.md'), content);
  }
  return folder;
}

function skillFile(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

test('renders placeholders and lists skills in the server instructions', () => {
  const skills = new McpSkills(createCustomFolder({
    instructions: '- Load at most {{ pageSize.max }} records.\n',
    skills: {
      zeta: skillFile('zeta-skill', 'Zeta, {{pageSize.default}} rows.', 'Zeta body.'),
      alpha: skillFile('alpha-skill', 'Alpha.', 'Alpha body with {{pageSize.max}}.'),
    },
  }), { 'pageSize.default': 20, 'pageSize.max': 200 });

  assert.equal(
    skills.serverInstructions(),
    `- Load at most 200 records.\n\nBefore a task, load the matching skill with ${FETCH_SKILL_TOOL_NAME}; it has the detailed rules:\n- alpha-skill: Alpha.\n- zeta-skill: Zeta, 20 rows.`,
  );
  assert.deepEqual(skills.call({ skillName: 'alpha-skill' }), { output: 'Alpha body with 200.', isError: false });
});

test('describes fetch_skill with the skill names as an enum', () => {
  const skills = new McpSkills(createCustomFolder({
    instructions: 'Rules.',
    skills: { only: skillFile('only-skill', 'Only.', 'Body.') },
  }), {});

  const tool = skills.toolDefinition();
  assert.equal(tool.name, FETCH_SKILL_TOOL_NAME);
  assert.deepEqual(tool.inputSchema.properties.skillName.enum, ['only-skill']);
  assert.deepEqual(tool.inputSchema.required, ['skillName']);
});

test('returns an error with the skill list for an unknown skill', () => {
  const skills = new McpSkills(createCustomFolder({
    instructions: 'Rules.',
    skills: { only: skillFile('only-skill', 'Only.', 'Body.') },
  }), {});

  assert.deepEqual(skills.call({ skillName: 'missing' }), {
    output: { error: 'Unknown skill: missing', skills: ['only-skill'] },
    isError: true,
  });
});

test('adds skills of shared custom folders as written, keeping the first skill of a name', () => {
  const skills = new McpSkills(
    createCustomFolder({ instructions: 'Rules.', skills: { fetch: skillFile('fetch-data', 'Own.', 'Own body.') } }),
    {},
    [
      createCustomFolder({
        skills: {
          fetch: skillFile('fetch-data', 'Project.', 'Project body.'),
          report: skillFile('report', 'Report.', 'Show {{ row.name }}.'),
        },
      }),
      createCustomFolder({ skills: {} }),
      createCustomFolder({ skills: { report: skillFile('report', 'Plugin report.', 'Plugin body.') } }),
      createCustomFolder({ skills: { dashboard: skillFile('dashboard', 'Dashboard.', 'Dashboard body.') } }),
    ],
  );

  assert.deepEqual(skills.toolDefinition().inputSchema.properties.skillName.enum, ['dashboard', 'fetch-data', 'report']);
  assert.equal(skills.call({ skillName: 'fetch-data' }).output, 'Own body.');
  assert.equal(skills.call({ skillName: 'report' }).output, 'Show {{ row.name }}.');
});

test('reads skill files with Windows line endings', () => {
  const skills = new McpSkills(createCustomFolder({ instructions: 'Rules.', skills: { own: skillFile('own', 'Own.', 'Own body.') } }), {}, [
    createCustomFolder({ skills: { crlf: '---\r\nname: crlf\r\ndescription: CRLF.\r\n---\r\nBody.\r\n' } }),
  ]);

  assert.equal(skills.call({ skillName: 'crlf' }).output, 'Body.');
});

test('fails on an unknown placeholder', () => {
  const folder = createCustomFolder({ instructions: 'Use {{unknown.value}}.', skills: {} });

  assert.throws(() => new McpSkills(folder, {}), /unknown placeholder \{\{unknown\.value\}\} in .*instructions\.md/);
});

test('loads the bundled instructions and skills with the plugin values', () => {
  const skills = new McpSkills(PLUGIN_CUSTOM_FOLDER, PLUGIN_VALUES);

  assert.deepEqual(skills.toolDefinition().inputSchema.properties.skillName.enum, ['analyze-data', 'fetch-data', 'mutate-data']);
  assert.doesNotMatch(skills.serverInstructions(), /\{\{/);
  for (const skillName of ['analyze-data', 'fetch-data', 'mutate-data']) {
    assert.doesNotMatch(skills.call({ skillName }).output, /\{\{/);
  }
});

test('fits the bundled server instructions into the client limit', () => {
  const { instructions } = createMcpServerPresentation(
    'Northwind Logistics Operations Back Office',
    'https://operations-admin.northwind-logistics.example.com/backoffice/admin',
    new McpSkills(PLUGIN_CUSTOM_FOLDER, {
      'pageSize.default': 1000,
      'pageSize.max': 10000,
      toolCallsPerRequest: 100,
    }).serverInstructions(),
  );

  assert.ok(
    instructions.length < CLIENT_INSTRUCTIONS_LIMIT,
    `server instructions are ${instructions.length} characters, clients cut them after ${CLIENT_INSTRUCTIONS_LIMIT}`,
  );
});
