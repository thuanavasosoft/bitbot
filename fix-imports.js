#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fixImportsInFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Fix relative imports that don't have .js extension (both ./ and ../ patterns)
    content = content.replace(
      /from\s+['"](\.\/[^'"]*?)(?<!\.js)['"]/g,
      (match, importPath) => {
        return match.replace(importPath, importPath + '.js');
      }
    );
    
    content = content.replace(
      /from\s+['"](\.\.\/[^'"]*?)(?<!\.js)['"]/g,
      (match, importPath) => {
        return match.replace(importPath, importPath + '.js');
      }
    );
    
    // Fix relative imports in import statements
    content = content.replace(
      /import\s+[^'"]*?\s+from\s+['"](\.\/[^'"]*?)(?<!\.js)['"]/g,
      (match, importPath) => {
        return match.replace(importPath, importPath + '.js');
      }
    );
    
    content = content.replace(
      /import\s+[^'"]*?\s+from\s+['"](\.\.\/[^'"]*?)(?<!\.js)['"]/g,
      (match, importPath) => {
        return match.replace(importPath, importPath + '.js');
      }
    );
    
    fs.writeFileSync(filePath, content);
    console.log(`Fixed imports in: ${filePath}`);
  } catch (error) {
    console.error(`Error fixing ${filePath}:`, error.message);
  }
}

function walkDirectory(dir) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      walkDirectory(filePath);
    } else if (file.endsWith('.js')) {
      fixImportsInFile(filePath);
    }
  }
}

// Start from the dist directory
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  walkDirectory(distDir);
  console.log('Import fixing completed!');
} else {
  console.error('Dist directory not found. Run npm run build first.');
}
