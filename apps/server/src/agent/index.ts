import type { FastifyInstance } from 'fastify'

import { registerAgentRoutes, publishAgentEvent } from './routes.js'

export { agentOutputsDir, agentRunsDir } from './config.js'
export { publishAgentEvent }
export type { AgentEvent } from './runner.js'

export async function registerAgent(app: FastifyInstance): Promise<void> {
  await registerAgentRoutes(app)
}
