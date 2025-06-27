#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, } from "@modelcontextprotocol/sdk/types.js";
import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createTwoFilesPatch } from 'diff';

// Définition d'interfaces pour les types utilisés dans le script
interface WslDistribution {
  name: string;
  state: string;
  version: string;
  isDefault: boolean;
}

interface WslFileStats {
  size: number;
  birthtime: Date;
  mtime: Date;
  atime: Date;
  mode: number;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

interface FileEntry {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

interface TreeEntry {
  name: string;
  type: 'file' | 'directory';
  children?: TreeEntry[];
}

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

interface EditOperationType {
  oldText: string;
  newText: string;
}

// Promisify exec pour utiliser async/await
const execAsync = promisify(exec);

// Command line argument parsing
const args = process.argv.slice(2);
const distroArg = args.find(arg => arg.startsWith('--distro='));
let allowedDistro: string | null = distroArg ? distroArg.split('=')[1] : null;
const pathArgs = args.filter(arg => !arg.startsWith('--'));

if (pathArgs.length === 0) {
  console.error("Usage: mcp-server-wsl-filesystem [--distro=name] <allowed-directory> [additional-directories...]");
  process.exit(1);
}

// Fonctions utilitaires pour manipuler les chemins en respectant les conventions Linux
function normalizePath(p: string): string {
  // Remplacer les chemins Windows par des chemins Linux
  p = p.replace(/\\/g, '/');
  // Gérer les doubles barres obliques
  p = p.replace(/\/+/g, '/');
  // Supprimer les points simples
  const parts = p.split('/');
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '.')
      continue;
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      }
      else {
        result.push('..');
      }
    }
    else if (part !== '') {
      result.push(part);
    }
  }
  let normalized = result.join('/');
  if (p.startsWith('/'))
    normalized = '/' + normalized;
  if (p.endsWith('/') && normalized !== '/')
    normalized += '/';
  return normalized || '.';
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    // Dans WSL, on peut obtenir le home directory avec $HOME
    return `$HOME${filepath.slice(1)}`;
  }
  return filepath;
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

function resolve(...paths: string[]): string {
  let resolvedPath = '';
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (isAbsolute(path)) {
      resolvedPath = path;
    }
    else {
      if (!resolvedPath)
        resolvedPath = process.cwd().replace(/\\/g, '/');
      resolvedPath = `${resolvedPath}/${path}`;
    }
  }
  return normalizePath(resolvedPath);
}

function dirname(p: string): string {
  const normalized = normalizePath(p);
  if (normalized === '/')
    return '/';
  if (!normalized.includes('/'))
    return '.';
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex === 0)
    return '/';
  if (lastSlashIndex === -1)
    return '.';
  return normalized.slice(0, lastSlashIndex);
}

function join(...paths: string[]): string {
  return normalizePath(paths.join('/'));
}

function isUtf16(str:string) {
  return str.indexOf('\0') !== -1;
}

function processOutput(output:string) {
  let lines;
  
  if (isUtf16(output)) {
    // Pour UTF-16
    const buffer = Buffer.from(output);
    const text = buffer.toString('utf16le');
    lines = text.trim().split('\n').slice(1);
  } else {
    // Pour UTF-8
    lines = output.toString().trim().split('\n').slice(1);
  }
  
  // Nettoyer les caractères restants comme les retours chariot
  return lines.map(line => line.replace(/\r/g, '').trim());
}

// Fonctions pour gérer les distributions WSL
async function listWslDistributions(): Promise<WslDistribution[]> {
  try {
      const { stdout } = await execAsync('wsl --list --verbose');
      const lines = processOutput(stdout);

      return lines.map(line => {
          // Gestion de l'astérisque pour la distribution par défaut
          const isDefault = line.trim().startsWith('*');
          // Supprimer l'astérisque si présent et diviser par espaces
          const parts = line.trim().replace(/^\*\s*/, '').split(/\s+/);
          
          const name = parts[0];
          const state = parts[1];
          const version = parts[2];
          
          return { 
              name, 
              state, 
              version,
              isDefault
          };
      });
  } catch (error) {
      console.error("Erreur lors de la récupération des distributions WSL:", error);
      return [];
  }
}

// Vérifier les distributions disponibles et définir la distribution par défaut si nécessaire
async function setupWslDistribution(): Promise<string> {
  const distributions = await listWslDistributions();

  if (distributions.length === 0) {
    console.error("Aucune distribution WSL n'a été trouvée sur ce système.");
    process.exit(1);
  }

  // Si aucune distribution spécifique n'est demandée, utiliser la distribution par défaut
  if (!allowedDistro) {
    const defaultDistro = distributions.find(d => d.isDefault);
    if (defaultDistro) {
        allowedDistro = defaultDistro.name;
    } else {
        // Si aucune distribution par défaut n'est marquée, utiliser la première
        allowedDistro = distributions[0].name;
    }
  } else {
    // Vérifier si la distribution demandée existe
    const exists = distributions.some(d => d.name.toLowerCase() === allowedDistro!.toLowerCase());
    if (!exists) {
      console.error(`La distribution WSL '${allowedDistro}' n'existe pas. Distributions disponibles:`);
      distributions.forEach(d => console.error(`- ${d.name}`));
      process.exit(1);
    }
  }

  console.error(`Utilisation de la distribution WSL: ${allowedDistro}`);
  return allowedDistro!;
}

// Initialiser la distribution WSL
setupWslDistribution().catch(error => {
  console.error("Erreur lors de l'initialisation de WSL:", error);
  process.exit(1);
});

// Store allowed directories in normalized form
const allowedDirectories = pathArgs.map(dir => normalizePath(resolve(expandHome(dir))));

/**
 * Exécute une commande unique dans WSL
 */
async function execWslCommand(command: string): Promise<string> {
  try {
    const wslCommand = allowedDistro ? `wsl -d ${allowedDistro} ${command}` : `wsl ${command}`;
    const { stdout } = await execAsync(wslCommand);
    return stdout.trim();
  }
  catch (error: any) {
    throw new Error(`WSL command failed: ${error.message}`);
  }
}

/**
 * Exécute une chaîne de commandes avec des pipes dans WSL
 * Chaque élément du tableau sera préfixé avec wsl [options] avant d'être joint par des pipes
 */
async function execWslPipeline(commands: string[]): Promise<string> {
  try {
    if (commands.length === 0) {
      throw new Error("No commands provided");
    }
    
    const joined = commands.join(" | ").replace(/"/g, '\\"');
    const fullCommand = allowedDistro
      ? `wsl -d ${allowedDistro} sh -c "${joined}"`
      : `wsl sh -c "${joined}"`;

    const { stdout } = await execAsync(fullCommand);
    return stdout.trim();
  }
  catch (error: any) {
    throw new Error(`WSL pipeline failed: ${error.message}`);
  }
}

// Convertir un chemin Windows en chemin WSL
function toWslPath(windowsPath: string): string {
  // Nettoyer et normaliser le chemin pour WSL
  const normalizedPath = normalizePath(windowsPath);
  // Échapper les caractères spéciaux pour la ligne de commande
  return normalizedPath.replace(/(["\s'$`\\])/g, '\\$1');
}

// Fonctions d'utilitaire pour les opérations de fichier via WSL
async function wslStat(filePath: string): Promise<WslFileStats> {
  const wslPath = toWslPath(filePath);
  try {
    const result = await execWslCommand(`stat -c "%s %Y %X %W %a %F" "${wslPath}"`);
    const [size, mtime, atime, birthtime, permissions, type] = result.split(' ');
    return {
      size: parseInt(size),
      birthtime: new Date(parseInt(birthtime) * 1000),
      mtime: new Date(parseInt(mtime) * 1000),
      atime: new Date(parseInt(atime) * 1000),
      mode: parseInt(permissions, 8),
      isDirectory: () => type.includes('directory'),
      isFile: () => type.includes('regular file')
    };
  } catch (error: any) {
    throw new Error(`Failed to stat ${filePath}: ${error.message}`);
  }
}

async function wslReaddir(dirPath: string): Promise<FileEntry[]> {
  const wslPath = toWslPath(dirPath);
  try {
    // Utiliser ls -la, mais filtrer . et .. (d'où le tail -n +3), et utiliser le bon format de sortie
    const result = await execWslCommand(
      `sh -c "ls -la \\"${wslPath}\\" | tail -n +3"`
    );
    if (!result)
      return [];

    return result.split('\n').map(line => {
      // Format typique: "drwxr-xr-x 2 user group 4096 Jan 1 12:34 dirname"
      const parts = line.trim().split(/\s+/);
      // Le nom peut contenir des espaces, donc nous prenons tout à partir de la 9ème colonne
      const name = parts.slice(8).join(' ');
      const isDir = line.startsWith('d');

      return {
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir
      };
    }).filter(entry => entry.name !== '.' && entry.name !== '..');
  } catch (error: any) {
    throw new Error(`Failed to read directory ${dirPath}: ${error.message}`);
  }
}

async function wslReadFile(filePath: string, encoding: string = 'utf-8'): Promise<string> {
  const wslPath = toWslPath(filePath);
  try {
    return await execWslCommand(`cat "${wslPath}"`);
  } catch (error: any) {
    throw new Error(`Failed to read file ${filePath}: ${error.message}`);
  }
}

async function wslWriteFile(filePath: string, content: string): Promise<void> {
  const wslPath = toWslPath(filePath);
  const tempFile = `/tmp/wsl_write_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

  try {
    // 1. Créer un fichier temporaire vide
    await execWslCommand(`touch "${tempFile}"`);

    // 2. Encoder le contenu en base64 pour éviter les problèmes de caractères spéciaux
    const buffer = Buffer.from(content);
    const base64Content = buffer.toString('base64');

    // 3. Écrire le contenu base64 par morceaux dans le fichier temporaire
    await writeBase64ContentByChunks(base64Content, tempFile);

    // 4. Déplacer le fichier temporaire vers la destination finale
    await execWslCommand(`mv "${tempFile}" "${wslPath}"`);
  } catch (error: any) {
    // En cas d'erreur, essayer de nettoyer le fichier temporaire
    try {
      await execWslCommand(`rm -f "${tempFile}"`);
    } catch (e) {
      // Ignorer les erreurs de nettoyage
    }
    throw new Error(`Failed to write to ${filePath}: ${error.message}`);
  }
}

// Nouvelle fonction pour écrire le contenu base64 par morceaux
async function writeBase64ContentByChunks(base64Content: string, targetPath: string): Promise<void> {
  // Taille maximale sécurisée pour éviter les erreurs de ligne trop longue
  const maxChunkSize = 4096;
  
  // Si le contenu est petit, utilisez la méthode directe
  if (base64Content.length <= maxChunkSize) {
    await execWslCommand(`bash -c "echo '${base64Content}' | base64 -d > '${targetPath}'"`);
    return;
  }
  
  // Vider le fichier cible
  await execWslCommand(`truncate -s 0 '${targetPath}'`);
  
  // Traiter le contenu par morceaux
  for (let i = 0; i < base64Content.length; i += maxChunkSize) {
    const chunk = base64Content.substring(i, i + maxChunkSize);
    // Pour le premier morceau, utilisez > (écraser)
    // Pour les morceaux suivants, utilisez >> (ajouter)
    const redirectOperator = i === 0 ? '>' : '>>';
    await execWslCommand(`bash -c "echo '${chunk}' | base64 -d ${redirectOperator} '${targetPath}'"`);
  }
}

async function wslMkdir(dirPath: string): Promise<void> {
  const wslPath = toWslPath(dirPath);
  try {
    await execWslCommand(`mkdir -p "${wslPath}"`);
  } catch (error: any) {
    throw new Error(`Failed to create directory ${dirPath}: ${error.message}`);
  }
}

async function wslRename(oldPath: string, newPath: string): Promise<void> {
  const wslOldPath = toWslPath(oldPath);
  const wslNewPath = toWslPath(newPath);
  try {
    await execWslCommand(`mv "${wslOldPath}" "${wslNewPath}"`);
  } catch (error: any) {
    throw new Error(`Failed to move ${oldPath} to ${newPath}: ${error.message}`);
  }
}

async function wslRealpath(filePath: string): Promise<string> {
  const wslPath = toWslPath(filePath);
  try {
    return await execWslCommand(`realpath "${wslPath}"`);
  } catch (error: any) {
    throw new Error(`Failed to resolve realpath for ${filePath}: ${error.message}`);
  }
}

// Validate that all directories exist and are accessible
async function validateDirectories(): Promise<void> {
  for (const dir of pathArgs) {
    try {
      const expandedDir = expandHome(dir);
      const stats = await wslStat(expandedDir);
      if (!stats.isDirectory()) {
        console.error(`Error: ${dir} is not a directory`);
        process.exit(1);
      }
    }
    catch (error) {
      console.error(`Error accessing directory ${dir}:`, error);
      process.exit(1);
    }
  }
}

// Initialize validation
validateDirectories().catch(error => {
  console.error("Failed to validate directories:", error);
  process.exit(1);
});

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = isAbsolute(expandedPath)
    ? resolve(expandedPath)
    : resolve(process.cwd().replace(/\\/g, '/'), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await wslRealpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  }
  catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = dirname(absolute);
    try {
      const realParentPath = await wslRealpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }
      return absolute;
    }
    catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const ListWslDistrosArgsSchema = z.object({});

const ReadFileByPartsArgsSchema = z.object({
  path: z.string(),
  part_number: z.number().int().positive().describe('Part number to read (1, 2, 3, etc.)')
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Server setup
const server = new Server({
  name: "secure-filesystem-server",
  version: "1.1.0",
}, {
  capabilities: {
    tools: {},
  },
});

// Tool implementations
async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await wslStat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

async function searchFilesByName(
  rootPath: string,
  pattern: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const wslRootPath = toWslPath(rootPath);
  const escapedPattern = pattern.replace(/"/g, '\\"');
  // Construire une commande find plus robuste
  const command = [`find "${wslRootPath}" -type f`];

  // Ajouter grep si pattern fourni
  if (pattern) {
    command.push(`grep -i "${escapedPattern}"`);
  }

  // Ajouter des filtres d'exclusion
  if (excludePatterns && excludePatterns.length > 0) {
     for (const ex of excludePatterns) {
      const excluded = ex.replace(/\*/g, ".*").replace(/"/g, '\\"');
      command.push(`grep -v "${excluded}"`);
    }
  }

  try {
    const result = await execWslPipeline(command);
    return result ? result.split("\n") : [];
  }
  catch (error: any) {
    // Si grep ne trouve rien, il renvoie une erreur, mais ce n'est pas une vraie erreur
    if (error.message.includes('no matches found') || error.message.includes('returned non-zero exit code')) {
      return [];
    }
    throw error;
  }
}

async function readFileByParts(filePath: string, partNumber: number): Promise<string> {
  const wslPath = toWslPath(filePath);
  const PART_SIZE = 95000;
  const MAX_BACKTRACK = 300;
  
  try {
    // Obtenir la taille du fichier
    const fileSizeStr = await execWslCommand(`bash -c "wc -c < '${wslPath}'"`);
    const fileSize = parseInt(fileSizeStr.trim());
    
    // Calculer la position de début théorique
    const theoreticalStart = (partNumber - 1) * PART_SIZE;
    
    // Vérifier si la partie demandée existe
    if (theoreticalStart >= fileSize) {
      throw new Error(`File has only ${fileSize.toLocaleString()} characters. Part ${partNumber} does not exist.`);
    }
    
    let actualStart = theoreticalStart;
    
    // Pour la première partie, pas de recul nécessaire
    if (partNumber === 1) {
      const content = await execWslCommand(`head -c ${PART_SIZE} "${wslPath}"`);
      return content;
    }
    
    // Pour les autres parties, trouver le début de ligne précédent
    if (partNumber > 1) {
      const searchStart = Math.max(0, theoreticalStart - MAX_BACKTRACK);
      const searchLength = theoreticalStart - searchStart;
      
      if (searchLength > 0) {
        // Lire la zone de recherche et trouver le dernier \n
        const searchContent = await execWslCommand(
          `bash -c "tail -c +${searchStart + 1} '${wslPath}' | head -c ${searchLength}"`
        );
        
        const lastNewlineIndex = searchContent.lastIndexOf('\n');
        
        if (lastNewlineIndex !== -1) {
          actualStart = searchStart + lastNewlineIndex + 1;
        }
      }
    }
    
    // Lire le contenu depuis actualStart
    let content = await execWslCommand(
      `bash -c "tail -c +${actualStart + 1} '${wslPath}' | head -c ${PART_SIZE}"`
    );
    
    // Pour les parties autres que la première, essayer de finir sur une ligne complète
    if (partNumber > 1 && content.length === PART_SIZE) {
      const endSearchStart = actualStart + PART_SIZE;
      
      if (endSearchStart < fileSize) {
        const remainingChars = Math.min(MAX_BACKTRACK, fileSize - endSearchStart);
        
        if (remainingChars > 0) {
          const endSearchContent = await execWslCommand(
            `bash -c "tail -c +${endSearchStart + 1} '${wslPath}' | head -c ${remainingChars}"`
          );
          
          const firstNewlineIndex = endSearchContent.indexOf('\n');
          
          if (firstNewlineIndex !== -1) {
            content += endSearchContent.substring(0, firstNewlineIndex + 1);
          }
        }
      }
    }
    
    return content;
  } catch (error: any) {
    if (error.message.includes('File has only')) {
      throw error;
    }
    throw new Error(`Failed to read file part ${partNumber} of ${filePath}: ${error.message}`);
  }
}

// file editing and diffing utilities
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, 'original', 'modified');
}

async function applyFileEdits(
  filePath: string,
  edits: EditOperationType[],
  dryRun: boolean = false
): Promise<string> {
  // Read file content and normalize line endings
  const content = normalizeLineEndings(await wslReadFile(filePath, 'utf-8'));

  // Apply edits sequentially
  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    // If exact match exists, use it
    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    // Otherwise, try line-by-line matching with flexibility for whitespace
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);

      // Compare lines with normalized whitespace
      const isMatch = oldLines.every((oldLine: string, j: number) => {
        const contentLine = potentialMatch[j];
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        // Preserve original indentation of first line
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line: string, j: number) => {
          if (j === 0)
            return originalIndent + line.trimStart();
          // For subsequent lines, try to preserve relative indentation
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  // Format diff with appropriate number of backticks
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    await wslWriteFile(filePath, modifiedContent);
  }

  return formattedDiff;
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "read_file",
        description: "Read the complete contents of a file from the file system. " +
          "Handles various text encodings and provides detailed error messages " +
          "if the file cannot be read. Use this tool when you need to examine " +
          "the contents of a single file. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
      },
      {
        name: "read_file_by_parts",
        description: "Read a file in parts of approximately 95,000 characters. " +
          "Use this for large files that cannot be read in one go. " +
          "Part 1 reads the first 95,000 characters. " +
          "Subsequent parts start at boundaries that respect line breaks when possible. " +
          "If a requested part number exceeds the file size, an error is returned with the actual file size.",
        inputSchema: zodToJsonSchema(ReadFileByPartsArgsSchema) as ToolInput,
      },
      {
        name: "read_multiple_files",
        description: "Read the contents of multiple files simultaneously. This is more " +
          "efficient than reading files one by one when you need to analyze " +
          "or compare multiple files. Each file's content is returned with its " +
          "path as a reference. Failed reads for individual files won't stop " +
          "the entire operation. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "write_file",
        description: "Create a new file or completely overwrite an existing file with new content. " +
          "Use with caution as it will overwrite existing files without warning. " +
          "Handles text content with proper encoding. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
      },
      {
        name: "edit_file",
        description: "Make line-based edits to a text file. Each edit replaces exact line sequences " +
          "with new content. Returns a git-style diff showing the changes made. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput,
      },
      {
        name: "create_directory",
        description: "Create a new directory or ensure a directory exists. Can create multiple " +
          "nested directories in one operation. If the directory already exists, " +
          "this operation will succeed silently. Perfect for setting up directory " +
          "structures for projects or ensuring required paths exist. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "list_directory",
        description: "Get a detailed listing of all files and directories in a specified path. " +
          "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
          "prefixes. This tool is essential for understanding directory structure and " +
          "finding specific files within a directory. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "directory_tree",
        description: "Get a recursive tree view of files and directories as a JSON structure. " +
          "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
          "Files have no children array, while directories always have a children array (which may be empty). " +
          "The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema) as ToolInput,
      },
      {
        name: "move_file",
        description: "Move or rename files and directories. Can move files between directories " +
          "and rename them in a single operation. If the destination exists, the " +
          "operation will fail. Works across different directories and can be used " +
          "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
        inputSchema: zodToJsonSchema(MoveFileArgsSchema) as ToolInput,
      },
      {
        name: "search_files_by_name",
        description: "Recursively search for files and directories matching a pattern. " +
          "Searches through all subdirectories from the starting path. The search " +
          "is case-insensitive and matches partial names. Returns full paths to all " +
          "matching items. Great for finding files when you don't know their exact location. " +
          "Only searches within allowed directories.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
      },
      {
        name: "get_file_info",
        description: "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
          "information including size, creation time, last modified time, permissions, " +
          "and type. This tool is perfect for understanding file characteristics " +
          "without reading the actual content. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
      },
      {
        name: "list_allowed_directories",
        description: "Returns the list of directories that this server is allowed to access. " +
          "Use this to understand which directories are available before trying to access files.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        } as ToolInput,
      },
      {
        name: "list_wsl_distributions",
        description: "Lists all available WSL distributions and shows which one is currently being used.",
        inputSchema: zodToJsonSchema(ListWslDistrosArgsSchema) as ToolInput,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    switch (name) {
      case "read_file": {
        const parsed = ReadFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const content = await wslReadFile(validPath);
        return {
          content: [{ type: "text", text: content }],
        };
      }
      case "read_file_by_parts": {
        const parsed = ReadFileByPartsArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file_by_parts: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const content = await readFileByParts(validPath, parsed.data.part_number);
        
        return {
          content: [{ 
            type: "text", 
            text: content
          }],
        };
      }
      case "read_multiple_files": {
        const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_multiple_files: ${parsed.error}`);
        }
        const results = await Promise.all(parsed.data.paths.map(async (filePath: string) => {
          try {
            const validPath = await validatePath(filePath);
            const content = await wslReadFile(validPath);
            return `${filePath}:\n${content}\n`;
          }
          catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return `${filePath}: Error - ${errorMessage}`;
          }
        }));
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }
      case "write_file": {
        const parsed = WriteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for write_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await wslWriteFile(validPath, parsed.data.content);
        return {
          content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }],
        };
      }
      case "edit_file": {
        const parsed = EditFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for edit_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const result = await applyFileEdits(validPath, parsed.data.edits, parsed.data.dryRun);
        return {
          content: [{ type: "text", text: result }],
        };
      }
      case "create_directory": {
        const parsed = CreateDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await wslMkdir(validPath);
        return {
          content: [{ type: "text", text: `Successfully created directory ${parsed.data.path}` }],
        };
      }
      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const entries = await wslReaddir(validPath);
        const formatted = entries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }
      case "directory_tree": {
        const parsed = DirectoryTreeArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for directory_tree: ${parsed.error}`);
        }
        async function buildTree(currentPath: string): Promise<TreeEntry[]> {
          const validPath = await validatePath(currentPath);
          const entries = await wslReaddir(validPath);
          const result: TreeEntry[] = [];
          for (const entry of entries) {
            const entryData: TreeEntry = {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file'
            };

            if (entry.isDirectory()) {
              const subPath = join(currentPath, entry.name);
              entryData.children = await buildTree(subPath);
            }

            result.push(entryData);
          }
          return result;
        }

        const treeData = await buildTree(parsed.data.path);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(treeData, null, 2)
          }],
        };
      }
      case "move_file": {
        const parsed = MoveFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for move_file: ${parsed.error}`);
        }
        const validSourcePath = await validatePath(parsed.data.source);
        const validDestPath = await validatePath(parsed.data.destination);
        await wslRename(validSourcePath, validDestPath);
        return {
          content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
        };
      }
      case "search_files_by_name": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_files_by_name: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const results = await searchFilesByName(validPath, parsed.data.pattern, parsed.data.excludePatterns || []);
        return {
          content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches found" }],
        };
      }
      case "get_file_info": {
        const parsed = GetFileInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const info = await getFileStats(validPath);
        return {
          content: [{
            type: "text", text: Object.entries(info)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n")
          }],
        };
      }
      case "list_allowed_directories": {
        return {
          content: [{
            type: "text",
            text: `Allowed directories:\n${allowedDirectories.join('\n')}`
          }],
        };
      }
      case "list_wsl_distributions": {
        const distributions = await listWslDistributions();
        const formattedList = distributions.map(d => {
          const isActive = allowedDistro && d.name.toLowerCase() === allowedDistro.toLowerCase()
            ? " (ACTIVE)"
            : d.name.includes("(Default)") ? " (DEFAULT)" : "";
          return `${d.name}${isActive} - State: ${d.state}, Version: ${d.version}`;
        }).join('\n');

        return {
          content: [{
            type: "text",
            text: `Available WSL Distributions:\n${formattedList}\n\nCurrently using: ${allowedDistro}`
          }],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Secure MCP WSL Filesystem Server running on stdio");
  console.error(`Using WSL distribution: ${allowedDistro}`);
  console.error("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});