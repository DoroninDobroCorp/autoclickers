periods = {
	"Soccer": {
		"P1": "I",
		"P2": "II",
	},
	"Tennis": {
		"P1": ["Set1", "1.Set", "1"],
		"P2": ["Set2", "2.Set", "2"],
		"P3": ["Set3", "3.Set", "3"],
		"P4": ["Set4", "4.Set", "4"],
		"P5": ["Set5", "5.Set", "5"],
	}
}

handicaps = {
	"Soccer": {
		121: "",
		123: "",
		83:  "1X",
		85:  "X2",
		734: "1 Ostatak",
		736: "2 Ostatak",
		737: "1 Ost. I",
		739: "2 Ost. I",
	},
	"Tennis": {
		1193: "G.",
		1194: "G.",
	}
}

def check_period(outcome: str, sport: str):
	if outcome.startswith('P'):
		return periods[sport][outcome[:2]]

def convert_handicaps(bet_num: int, sport: str):
	return handicaps[sport][bet_num]


def convert(outcome: str, sport: str, raw: dict):
	print(f"[DEBUG] CONVERTING OUTCOME: {outcome} FOR SPORT: {sport}")
	result = ""

	period = check_period(outcome, sport)
	if period:
		outcome = outcome[3:]

	if sport == "Soccer":
		# Individual totals
		if "IT" in outcome:
			outcome = outcome.replace("I", "")
			splited = outcome.split()
			team = splited[0][:2]
			sign = splited[0][2:]

			# Over
			if sign == ">":
				result = f"{team} {splited[1]}+"

			# Under
			elif sign == "<":
				result = f"{team} {splited[1]}-"
			
			if period:
				result += f" {period}"

		# Totals
		elif "T" in outcome:
			outcome = outcome.replace("T", "")
			splited = outcome.split()

			# Over
			if splited[0] == ">":
				result = f"{splited[1]}+"

			# Under
			elif splited[0] == "<":
				result = f"{splited[1]}-"
			
			if period:
				result += f" {period}"

		# Handicaps
		elif "H" in outcome:
			result += convert_handicaps(raw['bet_num'], sport)

		# 1X2
		elif "1" in outcome or "X" in outcome or "2" in outcome:
			if period:
				result = f"{outcome} {period}"
			else:
				result = outcome

	elif sport == "Tennis":
		# Individual totals
		if "IT" in outcome:
			outcome = outcome.replace("I", "")
			splited = outcome.split()
			team = splited[0][:2]
			sign = splited[0][2:]

			# Over
			if sign == ">":
				result = f"{team} {splited[1]}+"

			# Under
			elif sign == "<":
				result = f"{team} {splited[1]}-"
			
			# if period:
			# 	result += f" {period}"

		# Totals
		elif "T" in outcome:
			outcome = outcome.replace("T", "")
			splited = outcome.split()

			if period:
				result += f"{period[1]} "

			# Over
			if splited[0] == ">":
				result += f"{splited[1]}+"

			# Under
			elif splited[0] == "<":
				result += f"{splited[1]}-"
			
			if period:
				result += " G."
			else:
				result += " Gemova"

		# Handicaps
		elif "H" in outcome:
			splited = outcome.split()
			team = splited[0].replace('H', '')
			bet_num = raw['bet_num']
			line = raw['line']

			result += f"{team}H {line} {convert_handicaps(bet_num, sport)}"

		elif "G" in outcome:
			splited = outcome.split()
			team = splited[0].replace('G', '')

			if period:
				result += f"{team} G.{splited[1]} S.{period[2]}"

		# 1X2
		elif "1" in outcome or "X" in outcome or "2" in outcome:
			if period:
				result = f"{outcome} {period[0]}"
			else:
				result = outcome
	print(f"[DEBUG] CONVERSION RESULT: {result}")
	return result