# ghia-ai (VS Code extension)

Local-first VS Code helper that explains code and answers questions using your own Ollama models. It shows results in hovers, CodeLens, and a side panel with a single click.

## Quick start (local, Ollama)

1) Install prerequisites: Node 18+, npm, VS Code, and [Ollama](https://ollama.com).  
2) Pull a small model (default the extension expects):  
   ```bash
   ollama pull gemma3:1b
   ```  
   (Swap in your preferred model and update `codelensAI.model` in settings if desired.)
3) Use Node 24.14.0 (run `nvm use 24.14.0` if you have nvm; see `.nvmrc`).  
4) Install dependencies and build the extension:  
   ```bash
   npm install
   npm run build
   ```
5) Launch in VS Code for debugging: press `F5` (Run → Start Debugging) to open the Extension Development Host.  
6) Use it: click “Explain this code” CodeLens or the status bar “Ask AI” button; the side panel will show the answer from your local model.

## Configuration (VS Code settings)
- `codelensAI.ollamaEndpoint`: Ollama URL (default `http://89.116.212.35:11434`).  
- `codelensAI.model`: Model name to use (default `gemma3:1b`).  
- Other UI toggles live under the `codelensAI.prototype.*` settings.
