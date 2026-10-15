export type Role = 'teacher' | 'student'

export type BoardAccess = 'editor' | 'observer'

export type Tool =
  | 'select'
  | 'lasso'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'laser'
  | 'hand'
  | 'text'
  | 'equation'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'cuboid'
  | 'axes'
  | 'quad'
  | 'linear'
  | 'sine'
  | 'check'
  | 'cross'
  | 'image'

export type BackgroundKind = 'white' | 'black' | 'beige' | 'grid' | 'dotted' | 'lined' | 'coord' | 'custom'

export type Align = 'left' | 'center' | 'right'

export type EraserMode = 'pixel' | 'object'

type BaseObject = {
  id: string
  pageId: string
  z: number
  locked?: boolean
  groupId?: string
}

export type StrokeObject = BaseObject & {
  type: 'stroke'
  tool: 'pen' | 'ballpoint' | 'highlighter'
  points: number[]
  color: string
  size: number
  opacity: number
}

export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle' | 'cuboid' | 'axes' | 'quad' | 'linear' | 'sine'

export type ShapeObject = BaseObject & {
  type: 'shape'
  kind: ShapeKind
  x: number
  y: number
  w: number
  h: number
  stroke: string
  fill: string
  strokeWidth: number
  xStep?: number
  yStep?: number
}

export type TextObject = BaseObject & {
  type: 'text'
  x: number
  y: number
  w: number
  h: number
  text: string
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
  align: Align
}

export type ImageObject = BaseObject & {
  type: 'image'
  x: number
  y: number
  w: number
  h: number
  rotation: number
  src: string
  name?: string
}

export type EquationObject = BaseObject & {
  type: 'equation'
  x: number
  y: number
  w: number
  h: number
  tex: string
  color: string
  fontSize: number
  src: string
}

export type StampObject = BaseObject & {
  type: 'stamp'
  kind: 'check' | 'cross'
  x: number
  y: number
  size: number
  color: string
}

export type BoardObject = StrokeObject | ShapeObject | TextObject | ImageObject | EquationObject | StampObject

export type BoardMemberInfo = {
  name: string
  access: BoardAccess
}

export type BoardEntry = {
  id: string
  title: string
  role: Role
  teacherKey?: string
  bookingId?: string
  updatedAt: number
  createdAt: number
  members?: BoardMemberInfo[]
}

export type PresenceUser = {
  name: string
  color: string
  role: Role
  access?: BoardAccess
  clientId?: string
  userId?: string
}

export type BoardPerson = {
  id: number
  name: string
  color: string
  access: BoardAccess
  role: Role
  clientId: string
  userId: string
  self: boolean
}

export type DraftStroke = {
  id: string
  pageId: string
  tool: 'pen' | 'ballpoint' | 'highlighter'
  color: string
  size: number
  opacity: number
  points: number[]
  preview?: boolean
}

export type Presence = {
  user?: PresenceUser
  cursor?: { x: number; y: number; pageId: string } | null
  draft?: DraftStroke | null
  erase?: { pageId: string; x: number; y: number; r: number; mode?: EraserMode; active?: boolean; circles?: number[] } | null
  camera?: { x: number; y: number; zoom: number; pageId: string } | null
  laser?: { pageId: string; at: number; points: number[] } | null
}

export type StylePatch = {
  color?: string
  size?: number
  opacity?: number
  fill?: string
  strokeWidth?: number
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  align?: Align
  xStep?: number
  yStep?: number
}
