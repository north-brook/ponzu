Pod::Spec.new do |s|
  s.name           = 'Tailnet'
  s.version        = '1.0.0'
  s.summary        = 'Reads the network addresses that show whether Tailscale is on.'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'Northbrook PBC'
  s.homepage       = 'https://ponzu.design'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
