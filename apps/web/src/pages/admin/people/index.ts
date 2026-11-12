/**
 * Admin → People & Permissions: the member directory (PeopleSection, also
 * mounted by a store's Team tab) and the role list (PermissionsSection).
 *
 * Review ADM1-13 (2026-11-12): this was PeopleSections.tsx, 3,223 lines
 * and fifteen components. Each has its own file now: roles/ for the role
 * sheets, invite/ for inviting, members/ for one member's sheets, and
 * shared.tsx for what several of them use.
 */
export { PeopleSection } from './PeopleSection';
export { PermissionsSection } from './roles/PermissionsSection';
