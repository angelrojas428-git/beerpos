import { Router } from 'express';
import fs from 'fs';
import path from 'path';
const router = Router();
router.get('/manual', (_req, res) => {
  const p = path.resolve(process.cwd(), '..', 'docs', 'MANUAL.md');
  try {
    const md = fs.readFileSync(p, 'utf8');
    res.type('text/plain').send(md);
  } catch (e) {
    res.status(404).send('Manual not found');
  }
});
export default router;
