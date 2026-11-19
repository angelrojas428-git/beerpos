import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

const candidates = [
  path.resolve(process.cwd(), '..', 'docs', 'MANUAL.html'),
  path.resolve(process.cwd(), 'docs', 'MANUAL.html'),
  path.resolve(process.cwd(), '..', '..', 'docs', 'MANUAL.html'),
];

router.get('/manual', (_req, res) => {
  for (const p of candidates) {
    try {
      const html = fs.readFileSync(p, 'utf8');
      return res.type('html').send(html);
    } catch (e) {}
  }
  res.status(404).send('Manual not found');
});

export default router;
