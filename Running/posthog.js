(() => {
  const config = window.POSTHOG_CONFIG;
  if (!config?.projectApiKey || config.projectApiKey === 'PASTE_PROJECT_API_KEY_HERE') return;
  if (!/^https:\/\/[a-z0-9.-]+$/.test(config.apiHost || '')) return;

  let analytics = null;
  const currentPage = () => document.querySelector('.page.active')?.id.replace(/^page-/, '') || 'auth';
  const sanitizeUrl = value => {
    if (typeof value !== 'string') return value;
    try {
      const url = new URL(value, location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '[redacted-url]';
    }
  };
  const capturePageView = page => {
    if (analytics) analytics.capture('$pageview', { page });
  };

  window.trackProductEvent = (eventName, properties = {}) => {
    if (analytics) analytics.capture(eventName, properties);
  };
  window.trackProductPageView = capturePageView;

  // PostHog's official browser loader with autocapture and session replay disabled.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.crossOrigin='anonymous',p.async=!0,p.src=s.api_host.replace('.i.posthog.com','-assets.i.posthog.com')+'/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a='posthog',u.people=u.people||[],Object.defineProperty(u,'toString',{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e='posthog';return'posthog'!==a&&(e+='.'+a),t||(e+=' (stub)'),e}}),Object.defineProperty(u.people,'toString',{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)}}),o='init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setGroupPropertiesForFlags resetPersonPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing'.split(' '),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  window.posthog.init(config.projectApiKey, {
    api_host: config.apiHost,
    defaults: '2026-08-30',
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    respect_dnt: true,
    sanitize_properties(properties) {
      const sanitized = { ...properties };
      for (const key of ['$current_url', '$initial_current_url', '$referrer']) {
        if (sanitized[key]) sanitized[key] = sanitizeUrl(sanitized[key]);
      }
      return sanitized;
    },
    person_profiles: 'identified_only',
    loaded(posthog) {
      analytics = posthog;
      capturePageView(currentPage());
    },
  });
})();
