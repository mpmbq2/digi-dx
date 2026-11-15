import type { AgentOrchestrator, OrchestrationResult } from "../agents/orchestrator.js";
import type { PeripheryHostBridge } from "../sandbox/bridge.js";

// BuilderPanel — In-app agent side panel for conversational UI/UX customization (R16, F3, AE4).

export interface ChatMessage {
  id: string;
  sender: "user" | "agent" | "system";
  text: string;
  timestamp: number;
  result?: OrchestrationResult;
}

export class BuilderPanelController {
  private readonly orchestrator: AgentOrchestrator;
  private readonly bridge: PeripheryHostBridge;
  private messages: ChatMessage[] = [];
  private listeners = new Set<(messages: ChatMessage[]) => void>();

  constructor(orchestrator: AgentOrchestrator, bridge: PeripheryHostBridge) {
    this.orchestrator = orchestrator;
    this.bridge = bridge;

    this.addMessage("system", "Digi-Dx Periphery Builder Agent connected. Ask me to customize your operating dashboard, priority queues, or alerts.");
  }

  get history(): ChatMessage[] {
    return [...this.messages];
  }

  onUpdate(listener: (messages: ChatMessage[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const copy = this.history;
    for (const listener of this.listeners) {
      listener(copy);
    }
  }

  private addMessage(sender: ChatMessage["sender"], text: string, result?: OrchestrationResult): ChatMessage {
    const msg: ChatMessage = {
      id: Math.random().toString(36).substring(2, 9),
      sender,
      text,
      timestamp: Date.now(),
      result
    };
    this.messages.push(msg);
    this.notify();
    return msg;
  }

  async sendUserPrompt(prompt: string): Promise<ChatMessage> {
    this.addMessage("user", prompt);

    const result = await this.orchestrator.processRequest(prompt);

    if (result.status === "approved" && result.code) {
      // Mount the approved code into the sandbox
      if (result.target === "interaction") {
        this.bridge.mountInteraction(result.code);
      } else {
        this.bridge.mountPolicy(result.code);
      }
      return this.addMessage("agent", `${result.explanation}\n\nComponent code approved by validator and loaded into runtime.`, result);
    }

    if (result.status === "rejected_with_alternatives") {
      let responseText = `${result.explanation}`;
      if (result.suggestedAlternative) {
        responseText += `\n\nSuggestion: ${result.suggestedAlternative}`;
      }
      return this.addMessage("agent", responseText, result);
    }

    return this.addMessage("agent", "I could not generate a validated component for this request.", result);
  }

  clearHistory(): void {
    this.messages.length = 0;
    this.notify();
  }
}
