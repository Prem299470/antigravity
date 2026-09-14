#!/usr/bin/env python3
"""
CyberShield AI - Phone Number Verification Engine
Parses and cross-checks phone numbers to detect caller ID spoofing,
VoIP impersonation, and region/carrier mismatches.
Requirements: pip install phonenumbers
"""
import argparse, json, sys

NUMBER_TYPE_MAP = {
    0: 'FIXED_LINE', 1: 'MOBILE', 2: 'FIXED_LINE_OR_MOBILE',
    3: 'TOLL_FREE', 4: 'PREMIUM_RATE', 5: 'SHARED_COST',
    6: 'VOIP', 7: 'PERSONAL_NUMBER', 8: 'PAGER',
    9: 'UAN', 10: 'VOICEMAIL', -1: 'UNKNOWN'
}

def parse_number(raw):
    import phonenumbers
    from phonenumbers import geocoder, carrier, number_type
    try:
        parsed = phonenumbers.parse(raw, None)
    except phonenumbers.NumberParseException:
        try:
            parsed = phonenumbers.parse(raw, 'IN')
        except phonenumbers.NumberParseException as e:
            return {'error': 'parse_failed', 'message': str(e), 'raw': raw}
    is_valid = phonenumbers.is_valid_number(parsed)
    ntype = number_type(parsed)
    return {
        'raw': raw,
        'e164': phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164),
        'international': phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.INTERNATIONAL),
        'national': phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.NATIONAL),
        'country_code': parsed.country_code,
        'region': geocoder.description_for_number(parsed, 'en') or 'Unknown',
        'carrier': carrier.name_for_number(parsed, 'en') or '',
        'number_type': NUMBER_TYPE_MAP.get(ntype, 'UNKNOWN'),
        'number_type_id': ntype,
        'is_valid': is_valid,
        'is_voip': ntype == 6,
    }

def compare_numbers(inc, sav):
    import phonenumbers
    try: p1 = phonenumbers.parse(inc['raw'], None)
    except: p1 = phonenumbers.parse(inc['raw'], 'IN')
    try: p2 = phonenumbers.parse(sav['raw'], None)
    except: p2 = phonenumbers.parse(sav['raw'], 'IN')
    match_level = phonenumbers.is_number_match(p1, p2)
    is_exact = int(match_level) >= 3
    flags = []
    region_mismatch = inc.get('country_code') != sav.get('country_code')
    carrier_mismatch = False
    voip_impersonation = False
    if inc.get('carrier') and sav.get('carrier'):
        carrier_mismatch = inc['carrier'].lower() != sav['carrier'].lower()
    if inc.get('is_voip') and not sav.get('is_voip'):
        voip_impersonation = True
    if not is_exact: flags.append('number_mismatch')
    if region_mismatch: flags.append('region_mismatch')
    if carrier_mismatch: flags.append('carrier_mismatch')
    if voip_impersonation: flags.append('voip_impersonation')
    risk = 'low'
    if len(flags) >= 3: risk = 'critical'
    elif voip_impersonation or (not is_exact and region_mismatch): risk = 'high'
    elif len(flags) >= 1: risk = 'medium'
    return {
        'number_match': is_exact, 'region_mismatch': region_mismatch,
        'carrier_mismatch': carrier_mismatch, 'voip_impersonation': voip_impersonation,
        'flags': flags, 'flag_count': len(flags), 'risk_level': risk,
        'match_level': int(match_level),
    }

def main():
    parser = argparse.ArgumentParser(description='CyberShield Number Verification Engine')
    parser.add_argument('--incoming', required=True, help='Incoming phone number')
    parser.add_argument('--saved', default=None, help='Saved contact number for comparison')
    args = parser.parse_args()
    try:
        import phonenumbers
    except ImportError:
        print(json.dumps({'error':'phonenumbers_not_installed','message':'Install with: pip install phonenumbers'}))
        sys.exit(0)
    result = {'incoming': parse_number(args.incoming)}
    if args.saved:
        result['saved'] = parse_number(args.saved)
        if 'error' not in result['incoming'] and 'error' not in result['saved']:
            result['comparison'] = compare_numbers(result['incoming'], result['saved'])
        else:
            result['comparison'] = {'error': 'One or both numbers could not be parsed.'}
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
