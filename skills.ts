import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { McpToolDefinition } from './apiTools.js';

export const FETCH_SKILL_TOOL_NAME = 'fetch_skill';
const INSTRUCTIONS_FILE_NAME = 'instructions.md';
const SKILLS_DIR_NAME = 'skills';
const SKILL_FILE_NAME = 'SKILL.md';
// SKILL.md starts with YAML frontmatter between two --- lines, the rest is the skill body.
const SKILL_FILE_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
// Placeholders like {{pageSize.max}} in instructions and skills are filled from plugin options.
const TEMPLATE_PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

type TemplateValues = Record<string, string | number>;

interface McpSkill {
  name: string;
  description: string;
  instructions: string;
}

function renderTemplate(template: string, values: TemplateValues, source: string): string {
  return template.replace(TEMPLATE_PLACEHOLDER_RE, (_, key: string) => {
    if (!(key in values)) {
      throw new Error(`AdminForthMcpPlugin: unknown placeholder {{${key}}} in ${source}`);
    }
    return String(values[key]);
  });
}

function readSkill(skillsDir: string, directoryName: string, values: TemplateValues): McpSkill {
  const file = join(skillsDir, directoryName, SKILL_FILE_NAME);
  const [, frontmatter, body] = readFileSync(file, 'utf8').match(SKILL_FILE_RE)!;
  const metadata = YAML.parse(frontmatter) as { name: string; description: string };
  return {
    name: metadata.name,
    description: renderTemplate(metadata.description, values, file),
    instructions: renderTemplate(body.trim(), values, file),
  };
}

/**
 * Guidance for MCP clients, kept as Markdown in the plugin `custom` folder: `instructions.md` holds the rules every
 * client gets in the server instructions, `skills/<name>/SKILL.md` the detailed rules clients load with fetch_skill.
 */
export class McpSkills {
  private readonly instructions: string;
  private readonly skills: Map<string, McpSkill>;

  constructor(customFolderPath: string, values: TemplateValues) {
    const instructionsFile = join(customFolderPath, INSTRUCTIONS_FILE_NAME);
    this.instructions = renderTemplate(readFileSync(instructionsFile, 'utf8').trim(), values, instructionsFile);

    const skillsDir = join(customFolderPath, SKILLS_DIR_NAME);
    this.skills = new Map(
      readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readSkill(skillsDir, entry.name, values))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((skill) => [skill.name, skill]),
    );
  }

  serverInstructions(): string {
    const skillList = Array.from(this.skills.values())
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join('\n');
    return [
      this.instructions,
      `Before a task, load the matching skill with ${FETCH_SKILL_TOOL_NAME}; it has the detailed rules:\n${skillList}`,
    ].join('\n\n');
  }

  toolDefinition(): McpToolDefinition {
    return {
      name: FETCH_SKILL_TOOL_NAME,
      description: `Returns the detailed rules of a skill for working with this admin panel. Load the matching skill before the task. Skills: ${Array.from(this.skills.keys()).join(', ')}.`,
      inputSchema: {
        type: 'object',
        required: ['skillName'],
        properties: {
          skillName: { type: 'string', enum: Array.from(this.skills.keys()) },
        },
      },
    };
  }

  call(args: Record<string, unknown> | undefined): { output: unknown; isError: boolean } {
    const skill = this.skills.get(String(args?.skillName));
    if (!skill) {
      return {
        output: { error: `Unknown skill: ${args?.skillName}`, skills: Array.from(this.skills.keys()) },
        isError: true,
      };
    }
    return { output: skill.instructions, isError: false };
  }
}
