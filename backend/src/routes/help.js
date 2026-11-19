import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

const candidates = [
  path.resolve(process.cwd(), '..', 'docs', 'MANUAL.md'),
  path.resolve(process.cwd(), 'docs', 'MANUAL.md'),
  path.resolve(process.cwd(), '..', '..', 'docs', 'MANUAL.md'),
];

router.get('/manual', (_req, res) => {
  for (const p of candidates) {
    try {
      const md = fs.readFileSync(p, 'utf8');
      return res.type('text/plain').send(md);
    } catch (e) {}
  }
  res.status(404).send('Manual not found');
});

export default router;
