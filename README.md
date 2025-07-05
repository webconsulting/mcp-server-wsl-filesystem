> ⚠️ **IMPORTANT INFORMATION:**  
> The original [Filesystem MCP Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) can already access WSL files by simply using the network path `\\wsl.localhost\DistributionName` as a parameter in the configuration.  
> Example:
> 
> ```json
> {
>   "mcpServers": {
>     "filesystem": {
>       "command": "npx",
>       "args": [
>         "-y",
>         "@modelcontextprotocol/server-filesystem",
>         "\\\\wsl.localhost\\Debian",
>         "C:\\path\\to\\other\\allowed\\dir"
>       ]
>     }
>   }
> }
> ```
>
> However, this project offers an **alternative implementation specifically optimized for WSL Linux distributions**.
>
> While the official server works by recursively walking directories using Node.js’s `fs` module, this implementation leverages **native Linux commands inside WSL** (such as `find`, `grep`, etc.), making **file listing and content search operations significantly faster**.
>
> This can be especially useful when dealing with large directory trees or when search performance is critical.
>
> So while the native network path may be simpler for many use cases, this project remains **a valuable solution** for WSL users looking for **better performance** or more **custom control** over the indexing and searching logic.

---

# Filesystem MCP Server for WSL

[![npm version](https://img.shields.io/npm/v/mcp-server-wsl-filesystem.svg)](https://www.npmjs.com/package/mcp-server-wsl-filesystem)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Node.js server implementing the Model Context Protocol (MCP), specifically designed for filesystem operations in Windows Subsystem for Linux (WSL).  
This project is a fork of the original [Filesystem MCP Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) but completely reimagined for WSL environments.  
Unlike the original project, which handles generic file operations, this version focuses exclusively on seamless interaction between Windows and Linux distributions under WSL.  
Both projects are compatible and can run in parallel on the same system.

## Features

- Access any WSL distribution from Windows
- Read/write files in WSL from Windows host
- Create/list/delete directories in WSL
- Move files/directories across WSL filesystem
- Search files within WSL 
- Get file metadata from the WSL filesystem
- Support for multiple WSL distributions

**Note**: The server only allows operations within directories specified via `args`.

---

## API

### Resources

- `wsl -d <distrib>`: Command for operations on WSL distributions

### Tools

- **read_file**
  - Read complete contents of a file from WSL
  - Input: `path` (string)
  - Reads content as UTF-8 text

- **read_file_by_parts**
  - Read large files in parts of approximately 95,000 characters
  - Inputs:
    - `path` (string)
    - `part_number` (positive integer: 1, 2, 3, etc.)
  - Features:
    - Part 1 starts from the beginning of the file
    - Subsequent parts align to line boundaries (max 300 character adjustment)
    - Returns error with actual file size if requested part doesn't exist
    - Useful for files too large to read in one operation

- **read_multiple_files**
  - Read multiple files simultaneously from WSL
  - Input: `paths` (string[])
  - Failed reads won't stop the entire operation

- **write_file**
  - Create or overwrite a file in WSL (use with caution)
  - Inputs:
    - `path` (string)
    - `content` (string)

- **edit_file**
  - Selective edits with advanced pattern matching and formatting
  - Inputs:
    - `path` (string)
    - `edits` (array of `{ oldText, newText }`)
    - `dryRun` (boolean, optional)
  - Features:
    - Multi-line matching
    - Indentation preservation
    - Git-style diff preview
    - Non-destructive dry run mode

- **create_directory**
  - Create or ensure the existence of a directory in WSL
  - Input: `path` (string)

- **list_directory**
  - List directory contents with `[FILE]` or `[DIR]` prefixes
  - Input: `path` (string)

- **directory_tree**
  - Recursive JSON tree view of contents
  - Input: `path` (string)

- **move_file**
  - Move or rename files/directories
  - Inputs:
    - `source` (string)
    - `destination` (string)

- **search_files**
  - Recursively search by name
  - Inputs:
    - `path` (string)
    - `pattern` (string)
    - `excludePatterns` (string[], optional)

- **search_in_files**
  - Search for text patterns within files recursively
  - Inputs:
    - `path` (string) - root directory to search
    - `pattern` (string) - text or regex pattern to find
    - `caseInsensitive` (boolean, optional) - case-insensitive search
    - `isRegex` (boolean, optional) - treat pattern as regex
    - `includePatterns` (string[], optional) - file patterns to include (e.g., *.js)
    - `excludePatterns` (string[], optional) - file patterns to exclude
    - `maxResults` (number, optional, default: 1000) - maximum results to return
    - `contextLines` (number, optional, default: 0) - lines of context before/after
  - Features:
    - Handles all special characters (apostrophes, quotes, $, backslashes)
    - Supports plain text and regular expression searches
    - Shows matching lines with file paths and line numbers
    - Automatically excludes .git, node_modules, .svn, .hg directories
    - Can show context lines around matches

- **get_file_info**
  - Detailed metadata
  - Input: `path` (string)
  - Returns: size, timestamps, type, permissions

- **list_allowed_directories**
  - Lists all directories accessible to the server

- **list_wsl_distributions**
  - Lists available distributions and shows the active one

---

## Requirements

- [Windows Subsystem for Linux (WSL)](https://learn.microsoft.com/en-us/windows/wsl/install) properly configured
- At least one Linux distribution installed in WSL

**For Claude Desktop users:**  
No additional installation required — just configure your `claude_desktop_config.json`.

**NPM Package:**  
The package is available on npm: [mcp-server-wsl-filesystem](https://www.npmjs.com/package/mcp-server-wsl-filesystem)

**For development:**

- [Node.js](https://nodejs.org/en/download/) (v18.0.0 or higher)
- TypeScript (included as a dev dependency)

### Installing Node.js on Windows

1. Download the installer from [nodejs.org](https://nodejs.org/en/download/)
2. Run it and follow the instructions
3. Check versions:

```bash
node --version
npm --version
```

## Usage

Before running the server, you need to build the TypeScript project:
```bash
npm install
npm run build
```

Run the server by specifying which WSL distribution to use (optional) and which directories to expose:

```bash
node dist/index.js [--distro=distribution_name] <allowed_directory> [additional_directories...]
```

If no distribution is specified, the default WSL distribution will be used.

### Examples

Access Ubuntu-20.04 distribution:
```bash
node dist/index.js --distro=Ubuntu-20.04 /home/user/documents
```

Use default distribution:
```bash
node dist/index.js /home/user/documents
```

## Usage with Claude Desktop

Add this to your `claude_desktop_config.json`:

### Option 1: Using a specific WSL distribution

```json
{
  "mcpServers": {
    "wsl-filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-server-wsl-filesystem",
        "--distro=Ubuntu-20.04",
        "/home/user/documents"
      ]
    }
  }
}
```

### Option 2: Using the default WSL distribution

```json
{
  "mcpServers": {
    "wsl-filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-server-wsl-filesystem",
        "/home/user/documents"
      ]
    }
  }
}
```

In the second example, the system will use your default WSL distribution without you needing to specify it.

## Differences from original project

This fork adapts the original Filesystem MCP Server to work with WSL by:

1. Replacing direct Node.js filesystem calls with WSL command executions
2. Adding support for selecting specific WSL distributions
3. Implementing path translation between Windows and Linux formats
4. Enhancing file content handling for cross-platform compatibility
5. Adding specialized tools for WSL management

## License

This project is a fork of the original [Filesystem MCP Server](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem) created by the Model Context Protocol team.

This MCP server for WSL is licensed under the MIT License, following the original project's license. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the original project repository.