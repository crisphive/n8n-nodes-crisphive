// Copies the node and credential icons next to the compiled files (n8n loads
// them from dist). Source of truth: ../brand/ (the Crisphive mark).
import { cpSync, existsSync, mkdirSync } from "node:fs";
for (const dir of ["nodes/Crisphive", "nodes/CrisphiveTrigger", "credentials"]) {
  mkdirSync(`dist/${dir}`, { recursive: true });
  for (const f of ["crisphive.svg", "crisphive.dark.svg"]) {
    if (existsSync(`${dir}/${f}`)) cpSync(`${dir}/${f}`, `dist/${dir}/${f}`);
  }
}
