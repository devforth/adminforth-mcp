import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Tool } from '@modelcontextprotocol/server';

export const FETCH_SKILL_TOOL_NAME = 'fetch_skill';
const INSTRUCTIONS_FILE_NAME = 'instructions.md';
const SKILLS_DIR_NAME = 'skills';
const SKILL_FILE_NAME = 'SKILL.md';
// SKILL.md starts with YAML frontmatter between two --- lines, the rest is the skill body.
const SKILL_FILE_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
// Placeholders like {{pageSize.max}} in instructions and skills are filled from plugin options.
const TEMPLATE_PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

type TemplateValues = Record<string, string | number>;
type RenderSkillText = (text: string, file: string) => string;

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

function readSkill(skillsDir: string, directoryName: string, render: RenderSkillText): McpSkill {
  const file = join(skillsDir, directoryName, SKILL_FILE_NAME);
  const [, frontmatter, body] = readFileSync(file, 'utf8').match(SKILL_FILE_RE)!;
  const metadata = YAML.parse(frontmatter) as { name: string; description: string };
  return {
    name: metadata.name,
    description: render(metadata.description, file),
    instructions: render(body.trim(), file),
  };
}

function readSkills(skillsDir: string, render: RenderSkillText): McpSkill[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkill(skillsDir, entry.name, render));
}

/**
 * Guidance for MCP clients, kept as Markdown in the plugin `custom` folder: `instructions.md` holds the rules every
 * client gets in the server instructions, `skills/<name>/SKILL.md` the detailed rules clients load with fetch_skill.
 * Skills from `skills` of the shared custom folders (the project and other plugins) are added as written; a skill
 * whose name is already taken by the plugin or an earlier folder is skipped.
 */
export class McpSkills {
  private readonly instructions: string;
  private readonly skills: Map<string, McpSkill>;

  constructor(customFolderPath: string, values: TemplateValues, sharedCustomFolderPaths: string[] = []) {
    const instructionsFile = join(customFolderPath, INSTRUCTIONS_FILE_NAME);
    this.instructions = renderTemplate(readFileSync(instructionsFile, 'utf8').trim(), values, instructionsFile);

    const skills = [
      ...readSkills(join(customFolderPath, SKILLS_DIR_NAME), (text, file) => renderTemplate(text, values, file)),
      ...sharedCustomFolderPaths
        .map((folderPath) => join(folderPath, SKILLS_DIR_NAME))
        .filter((skillsDir) => existsSync(skillsDir))
        .flatMap((skillsDir) => readSkills(skillsDir, (text) => text)),
    ];
    this.skills = new Map(
      skills
        .filter((skill, index) => skills.findIndex((other) => other.name === skill.name) === index)
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

  toolDefinition(): Tool {
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
