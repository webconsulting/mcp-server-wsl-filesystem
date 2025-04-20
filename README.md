# Filesystem MCP Server for WSL

Node.js server implementing Model Context Protocol (MCP) specifically designed for filesystem operations in Windows Subsystem for Linux (WSL). This project is a fork of the original [Filesystem MCP Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) but completely reimagined for WSL environments. Unlike the original project which handles generic file operations, this version focuses exclusively on seamless interaction between Windows and Linux distributions under WSL. Both projects are compatible and can run in parallel on the same system.

## Features

- Access any WSL distribution from Windows
- Read/write files in WSL from Windows host
- Create/list/delete directories in WSL
- Move files/directories across WSL filesystem
- Search files within WSL 
- Get file metadata from WSL filesystem
- Support for multiple WSL distributions

**Note**: The server will only allow operations within directories specified via `args`.

## API

### Resources

- `wsl -d <distrib>`: Command for operations on WSL distributions

### Tools

- **read_file**
  - Read complete contents of a file from WSL
  - Input: `path` (string)
  - Reads complete file contents with UTF-8 encoding

- **read_multiple_files**
  - Read multiple files simultaneously from WSL
  - Input: `paths` (string[])
  - Failed reads won't stop the entire operation

- **write_file**
  - Create new file or overwrite existing in WSL (exercise caution)
  - Inputs:
    - `path` (string): File location
    - `content` (string): File content

- **edit_file**
  - Make selective edits using advanced pattern matching and formatting in WSL files
  - Features:
    - Line-based and multi-line content matching
    - Whitespace normalization with indentation preservation
    - Multiple simultaneous edits with correct positioning
    - Indentation style detection and preservation
    - Git-style diff output with context
    - Preview changes with dry run mode
  - Inputs:
    - `path` (string): File to edit
    - `edits` (array): List of edit operations
      - `oldText` (string): Text to search for (can be substring)
      - `newText` (string): Text to replace with
    - `dryRun` (boolean): Preview changes without applying (default: false)
  - Returns detailed diff and match information for dry runs, otherwise applies changes

- **create_directory**
  - Create new directory or ensure it exists in WSL
  - Input: `path` (string)
  - Creates parent directories if needed
  - Succeeds silently if directory exists

- **list_directory**
  - List directory contents in WSL with [FILE] or [DIR] prefixes
  - Input: `path` (string)

- **directory_tree**
  - Get a recursive tree view of files and directories as a JSON structure
  - Input: `path` (string)
  - Returns tree structure with name, type, and children properties

- **move_file**
  - Move or rename files and directories in WSL
  - Inputs:
    - `source` (string)
    - `destination` (string)
  - Fails if destination exists

- **search_files**
  - Recursively search for files/directories in WSL
  - Inputs:
    - `path` (string): Starting directory
    - `pattern` (string): Search pattern
    - `excludePatterns` (string[]): Exclude any patterns. Glob formats are supported.
  - Case-insensitive matching
  - Returns full paths to matches

- **get_file_info**
  - Get detailed file/directory metadata from WSL
  - Input: `path` (string)
  - Returns:
    - Size
    - Creation time
    - Modified time
    - Access time
    - Type (file/directory)
    - Permissions

- **list_allowed_directories**
  - List all directories the server is allowed to access in WSL
  - No input required

- **list_wsl_distributions**
  - Lists all available WSL distributions and shows which one is currently being used
  - No input required

## Requirements

- [Windows Subsystem for Linux (WSL)](https://learn.microsoft.com/en-us/windows/wsl/install) properly configured
- At least one Linux distribution installed in WSL

For Claude Desktop users: No additional installation required

For development:
- [Node.js](https://nodejs.org/en/download/) (v14.0.0 or higher)
- TypeScript (installed as a development dependency)

### Installing Node.js on Windows

1. Download the Windows installer from the [official Node.js website](https://nodejs.org/en/download/)
2. Run the installer and follow the installation wizard
3. Verify installation by opening Command Prompt and running:
   ```bash
   node --version
   npm --version

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