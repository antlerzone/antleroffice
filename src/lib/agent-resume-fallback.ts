export interface ResumeAgent {
  id: string
  name: string
  role: string
  runtime?: string
  sprite?: number
  hueShift?: number
  salaryCreditsPerMonth?: number | null
  hiredAt?: number | null
  templateId?: string | null
  skillIds?: string[]
  openclawSkillNames?: string[]
  mcpIds?: string[]
  mcpBindings?: { mcpId: string; accountIds: string[] }[]
}

export interface JobScopeCard {
  key: string
  icon: string
  label: string
  text: string
}

export interface AdditionalCapability {
  kind: 'skill' | 'openclaw' | 'mcp'
  id: string
  label: string
  name: string
  detail?: string
}

export interface SkillDetail {
  id: string
  name: string
  systemPreview?: string
  version?: number
  description?: string
  additional?: boolean
  learnedVersion?: number
}

export interface AgentOverview {
  ok?: boolean
  description?: string
  examples?: string[]
  jobScope?: JobScopeCard[]
  skills?: SkillDetail[]
  baseSkills?: SkillDetail[]
  additionalSkills?: SkillDetail[]
  lockedSkills?: SkillDetail[]
  outdatedSkills?: SkillDetail[]
  mcps?: { id: string; name: string; additional?: boolean }[]
  baseMcps?: { id: string; name: string }[]
  additionalMcps?: { id: string; name: string }[]
  additionalOpenclawSkills?: string[]
  additionalCapabilities?: AdditionalCapability[]
  openclawSkills?: string[]
  soulPreview?: string
  modelRef?: string
  catalog?: {
    description?: string
    tagline?: string
    examples?: string[]
    highlights?: string[]
  } | null
  live?: {
    npcState?: string
    bubbleText?: string
    currentJob?: string | null
  }
}

const ROLE_RESUME: Record<
  string,
  { description: string; examples: string[] }
> = {
  graphic_design: {
    description:
      'This graphic design agent creates pixel art, office NPC skins, posters, banners, and brand visuals. Hire them when you need on-brand images without opening a design tool.',
    examples: [
      'Ask this agent to design a new NPC skin for someone in your office.',
      'Turn a short product brief into a social banner or poster.',
    ],
  },
  human_resource: {
    description:
      'This human resource agent helps you create and publish new SaaS NPC workers on the ECS catalog — with descriptions, skills, bundles, and department listings.',
    examples: [
      'Ask HR to draft a new marketing worker with plain-English examples for clients.',
      'Publish a hidden VIP agent with a UUID and hire password.',
    ],
  },
  security: {
    description:
      'This security worker drives an Android phone via ADB + Appium to auto-run gate, visitor, and property flows (iCares, Veemios, eCommunity, GProp, Klik Asia). One phone = one worker; plug in more phones to grab more jobs.',
    examples: [
      'Hire one Security Worker per Android phone you want to run jobs.',
      'Follow the setup guide to install Android Studio, ADB, and Appium, then plug in your phone.',
    ],
  },
  secretary: {
    description:
      'Your COO and the only Boss Chat front door. The COO records what you need and delegates work to your department workers.',
    examples: [
      'Chat with COO about what you want done today.',
      'Tell your COO your goals — it will delegate to the team.',
    ],
  },
  ceo: {
    description:
      'Your hired COO runs brainstorm → plan → execute → review and delegates to department workers. Hire from the Agents page.',
    examples: [
      'Ask your COO to plan a launch and assign Marketing.',
      'Have the COO research a competitor and summarize findings.',
    ],
  },
  coo: {
    description:
      'Your COO — hire one from the Agents page to run brainstorm → plan → execute → review.',
    examples: ['Hire a COO from Agents → Browse.'],
  },
}

function formatRole(role?: string) {
  if (!role) return 'Office worker'
  return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function skillLabels(
  agent: ResumeAgent,
  skillNameById: Map<string, string>,
): string[] {
  if (agent.openclawSkillNames?.length) {
    return agent.openclawSkillNames.map((n) => n.replace(/-/g, ' '))
  }
  return (agent.skillIds || []).map((id) => skillNameById.get(id) || id.replace(/_/g, ' '))
}

function mcpLabels(
  agent: ResumeAgent,
  mcpNameById: Map<string, string>,
): string[] {
  const ids = agent.mcpBindings?.length
    ? agent.mcpBindings.map((b) => b.mcpId)
    : agent.mcpIds || []
  return ids.map((id) => mcpNameById.get(id) || id)
}

export function buildAgentOverviewFallback(
  agent: ResumeAgent,
  skillNameById: Map<string, string>,
  mcpNameById: Map<string, string>,
): Pick<AgentOverview, 'description' | 'examples' | 'jobScope' | 'openclawSkills'> {
  const roleKey = String(agent.role || '').trim().toLowerCase()
  const preset = ROLE_RESUME[roleKey]
  const roleLabel = formatRole(agent.role)
  const ecsSkills = skillLabels(agent, skillNameById)
  const openclawSkills = agent.openclawSkillNames || []
  const mcpNames = mcpLabels(agent, mcpNameById)

  const description =
    preset?.description ||
    `${agent.name} is your ${roleLabel} agent in AntlerOffice. Assign tasks from the office or chat to put them to work.`

  const examples =
    preset?.examples ||
    [
      `Ask ${agent.name} to handle a typical ${roleLabel.toLowerCase()} task.`,
      `Delegate a recurring workflow so you do not repeat the same steps yourself.`,
    ]

  const jobScope: JobScopeCard[] = [
    {
      key: 'role',
      icon: 'briefcase',
      label: 'Office role',
      text: `${roleLabel} — handles ${roleLabel.toLowerCase()} work in your office.`,
    },
    {
      key: 'skills',
      icon: 'gear',
      label: 'ECS skills',
      text: ecsSkills.length ? ecsSkills.join(' · ') : 'No ECS skills linked yet.',
    },
    {
      key: 'openclaw',
      icon: 'gear',
      label: 'OpenClaw workflows',
      text: openclawSkills.length
        ? openclawSkills.join(' · ')
        : 'No OpenClaw workspace skills installed.',
    },
    {
      key: 'tools',
      icon: 'wrench',
      label: 'Integrated tools',
      text: mcpNames.length ? mcpNames.join(' · ') : 'No MCP tools linked.',
    },
  ]

  return { description, examples, jobScope, openclawSkills }
}

export function normalizeAgentOverview(
  raw: AgentOverview,
  agent: ResumeAgent,
  skillNameById: Map<string, string>,
  mcpNameById: Map<string, string>,
): AgentOverview {
  const fallback = buildAgentOverviewFallback(agent, skillNameById, mcpNameById)
  const description =
    raw.description?.trim() ||
    raw.catalog?.description?.trim() ||
    raw.catalog?.tagline?.trim() ||
    fallback.description
  const examples =
    raw.examples?.length
      ? raw.examples
      : raw.catalog?.examples?.length
        ? raw.catalog.examples
        : raw.catalog?.highlights?.map((h) => `Example: ${h}`) || fallback.examples
  const jobScope = raw.jobScope?.length ? raw.jobScope : fallback.jobScope
  const skills = raw.skills?.length ? raw.skills : undefined
  return {
    ...raw,
    description,
    examples,
    jobScope,
    openclawSkills: raw.openclawSkills?.length ? raw.openclawSkills : fallback.openclawSkills,
    skills,
  }
}
