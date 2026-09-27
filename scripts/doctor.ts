import { doctor } from "../src/integrations/doctor.ts";
const result = await doctor(process.cwd());
console.log(result.lines.join("\n"));
if (!result.ok) process.exitCode = 1;
