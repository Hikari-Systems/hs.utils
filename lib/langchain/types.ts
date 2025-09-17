export interface ToolArgumentDef {
  name: string;
  type: string;
  description: string;
  required: boolean;
}
export interface ToolDef {
  name: string;
  description: string;
  argDefs: ToolArgumentDef[];
  callable: (args: Record<string, any>) => any;
}
