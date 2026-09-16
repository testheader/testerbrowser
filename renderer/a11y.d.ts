export function initA11y(): void;
export function reloadA11yIfLoaded(): void;
export function enableA11yHover(): void;
export function disableA11yHover(): void;
export function loadA11yTree(): Promise<void>;

export interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  role?: { value?: string };
  name?: { value?: string };
  properties?: { name: string; value?: { value?: unknown } }[];
  backendDOMNodeId?: number;
}

export interface AxHeading {
  backendDOMNodeId?: number;
  level: number | null;
  name?: string;
}

export interface AxLandmark {
  backendDOMNodeId?: number;
  role: string;
  name?: string;
}

export interface HeadingSkip {
  heading: AxHeading;
  fromLevel: number;
  toLevel: number;
}

export function flattenAxTree(nodes: AxNode[]): AxNode[];
export function extractHeadings(orderedNodes: AxNode[]): AxHeading[];
export function extractLandmarks(orderedNodes: AxNode[]): AxLandmark[];
export function findHeadingSkips(headings: AxHeading[]): HeadingSkip[];
export function hasMainLandmark(landmarks: { role: string }[]): boolean;
