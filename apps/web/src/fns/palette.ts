import { createServerFn } from '@tanstack/react-start'
import { authed } from './middleware'
import { paletteIndex } from '../server/ops/palette'

/** Command palette items for the signed-in person. Titles and ids only. */
export const fetchPalette = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => paletteIndex(context.session.org.id, context.session.user.id))
