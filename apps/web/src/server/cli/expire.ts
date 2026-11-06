import { expireProposals } from '../response/proposals'
import { expireKqlProposals } from '../hunting/hunts'
import { runCli } from './run'

runCli('expire:proposals', async () => ({ response: await expireProposals(), kql: await expireKqlProposals() }))
