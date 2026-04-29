import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

export interface SkillFull extends SkillMeta {
  instructions: string;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (!key || rest.length === 0) continue;
    meta[key.trim()] = rest.join(':').trim();
  }

  return { meta, body: match[2].trim() };
}

export function discoverSkills(skillsDir = './skills'): SkillMeta[] {
  if (!existsSync(skillsDir)) return [];

  const skills: SkillMeta[] = [];

  for (const folder of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, folder, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    const content = readFileSync(skillPath, 'utf-8');
    const { meta } = parseFrontmatter(content);

    if (meta.name && meta.description) {
      skills.push({
        name: meta.name,
        description: meta.description,
        path: `/skills/${folder}/SKILL.md`,
      });
    }
  }

  return skills;
}

export function loadSkill(skillName: string, skillsDir = './skills'): SkillFull | null {
  if (!existsSync(skillsDir)) return null;

  for (const folder of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, folder, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    const content = readFileSync(skillPath, 'utf-8');
    const { meta, body } = parseFrontmatter(content);

    if (meta.name === skillName) {
      return {
        name: meta.name,
        description: meta.description,
        path: `/skills/${folder}/SKILL.md`,
        instructions: body,
      };
    }
  }

  return null;
}

export function buildSkillCatalog(skills: SkillMeta[]): string {
  if (skills.length === 0) return 'No skills available.';

  return skills
    .map((skill) =>
      `- **${skill.name}**: ${skill.description}\n  Read full instructions: cat ${skill.path}`,
    )
    .join('\n');
}
