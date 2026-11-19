/**
 * Travella prompts for the service-layer spike (docs/design/service-layers.md,
 * Eval). Answer keys were written by reading travella at origin/main (20b0b34);
 * probe.ts asserts every key symbol still exists in the index.
 *
 * `query` is the explore call an agent would plausibly send first: a symbol bag
 * plus, for named prompts, the service words from the question. Each control
 * keeps the same flow and the same symbol bag with the service words removed,
 * so control vs named isolates what the service words do.
 */
export interface KeySymbol { qualifiedName: string; file: string }
export interface EvalPrompt {
  id: string;
  prompt: string;
  query: string;
  /** Declared service ids the prompt names (empty for controls). */
  names: string[];
  key: KeySymbol[];
}

const k = (qualifiedName: string, file: string): KeySymbol => ({ qualifiedName, file });

const KEYS = {
  createPlan: [
    k('PlansApp::createPlan', 'frontend/src/PlansApp.jsx'),
    k('plansApi::create', 'frontend/src/plansApi.js'),
    k('request', 'frontend/src/api.js'),
    k('create_app::lifecycle_proxy', 'services/auth/api.py'), // the auth service proxies /v1/plans to CRUD
    k('CrudClient::request', 'services/auth/crud_client.py'),
    k('create_router::create', 'services/crud/api.py'),
    k('PlanRepository::create', 'services/crud/repository.py'),
  ],
  research: [
    k('_MapsObserver::_call', 'services/agent/claude/canvas_editor.py'),
    k('MapsClient::call', 'services/agent/maps_client.py'),
    k('CanvasTravelObserver::_call', 'services/agent/claude/canvas_travel.py'),
    k('TravelClient::call', 'services/agent/travel_client.py'),
    k('resolve_destination_area', 'services/mcps/map_server.py'),
    k('search_places', 'services/mcps/map_server.py'),
    k('get_place_details', 'services/mcps/map_server.py'),
    k('travel_search', 'services/mcps/travel_server.py'),
  ],
  planSummary: [
    k('summarize_plan', 'services/crud/plan_summary.py'),
    k('_ref', 'services/crud/repository.py'),
    k('PlanOutput', 'services/crud/schemas.py'),
    k('PlanOutput::from_ref', 'services/crud/schemas.py'),
    k('PlansApp', 'frontend/src/PlansApp.jsx'),
    k('PlansJournal', 'frontend/src/features/plans/components/PlansJournal.jsx'),
    k('PlanDrawer', 'frontend/src/features/plans/components/PlanDrawers.jsx'),
  ],
  token: [
    k('create_app::current_session', 'services/auth/api.py'),
    k('create_app::identity', 'services/auth/api.py'),
    k('CognitoJwtVerifier::__call__', 'services/auth/jwt_verifier.py'),
    k('validate_claims', 'services/auth/token_validator.py'),
    k('create_app::lifecycle_proxy', 'services/auth/api.py'),
    k('CrudClient::request', 'services/auth/crud_client.py'),
    k('bearer_identity', 'services/crud/auth.py'),
    k('identity_dependency', 'services/crud/auth.py'),
  ],
  profile: [
    k('AgentTurnService::handle', 'services/agent/service.py'),
    k('CrudContextReader::profile', 'services/agent/crud_client.py'),
    k('create_profile_router::get_traveler_profile', 'services/crud/api.py'),
    k('profile_context', 'services/shared/traveler_profile.py'),
    k('bind_traveler_profile', 'services/agent/request_context.py'),
    k('current_traveler_profile', 'services/agent/request_context.py'),
  ],
};

export const PROMPTS: EvalPrompt[] = [
  { id: 'N1', names: ['portal', 'crud'], key: KEYS.createPlan,
    prompt: 'How does the portal create a plan and get it stored by the CRUD backend?',
    query: 'portal createPlan plansApi create CRUD backend store plan PlanRepository create' },
  { id: 'N2', names: ['agent', 'connector'], key: KEYS.research,
    prompt: 'What does the agent service call in the connector service during research?',
    query: 'agent service research connector service MapsClient call TravelClient call mcp tool' },
  { id: 'N3', names: ['portal', 'crud'], key: KEYS.planSummary,
    prompt: "What breaks in the portal if I change the CRUD backend's plan summary schema?",
    query: 'portal CRUD backend plan summary schema summarize_plan PlanOutput destination_summary' },
  { id: 'N4', names: ['auth', 'crud'], key: KEYS.token,
    prompt: 'How does the auth service validate a token before the CRUD backend serves a request?',
    query: 'auth service validate token current_session identity CRUD backend bearer_identity identity_dependency' },
  { id: 'N5', names: ['agent'], key: KEYS.profile,
    prompt: "Where does the agent service read a traveler's profile from?",
    query: 'agent service read traveler profile CrudContextReader profile handle' },

  { id: 'C1', names: [], key: KEYS.createPlan,
    prompt: 'How does PlansApp.createPlan reach PlanRepository.create?',
    query: 'createPlan plansApi create store plan PlanRepository create' },
  { id: 'C2', names: [], key: KEYS.research,
    prompt: 'What tools do MapsClient.call and TravelClient.call invoke during research?',
    query: 'research MapsClient call TravelClient call tool' },
  { id: 'C3', names: [], key: KEYS.planSummary,
    prompt: 'What depends on summarize_plan and PlanOutput.destination_summary?',
    query: 'plan summary schema summarize_plan PlanOutput destination_summary' },
  { id: 'C4', names: [], key: KEYS.token,
    prompt: 'How do current_session and identity relate to bearer_identity and identity_dependency?',
    query: 'validate token current_session identity bearer_identity identity_dependency' },
  { id: 'C5', names: [], key: KEYS.profile,
    prompt: 'Where does AgentTurnService.handle get the traveler profile from?',
    query: 'read traveler profile CrudContextReader profile handle' },
];
